#!/usr/bin/env tsx
/**
 * Ingestion crawler for AZTN (Agencija za zastitu trzisnog natjecanja) decisions.
 *
 * Data source: aztn.hr WordPress REST API + attached PDF documents.
 *
 * Pipeline:
 *   Phase 1 (Index):   Paginate /wp-json/wp/v2/decision to collect all decision IDs
 *   Phase 2 (Media):   For each decision, fetch attached PDF URL via /wp-json/wp/v2/media
 *   Phase 3 (Content): Download PDFs, extract text, parse metadata, insert into SQLite
 *
 * Case-number prefixes map to decision types:
 *   UP/I 034-03  — competition enforcement (cartels, abuse of dominance, vertical restraints)
 *   UP/I 030-02  — older competition enforcement decisions
 *   011-01       — administrative / procedural / opinions
 *   025-01       — opinions (misljenja)
 *   UP/II        — merger control (concentrations)
 *   UP/I 430-01  — state aid (excluded — separate post type)
 *
 * Usage:
 *   npx tsx scripts/ingest-aztn.ts
 *   npx tsx scripts/ingest-aztn.ts --resume
 *   npx tsx scripts/ingest-aztn.ts --dry-run
 *   npx tsx scripts/ingest-aztn.ts --force
 *   npx tsx scripts/ingest-aztn.ts --limit 50
 *   npx tsx scripts/ingest-aztn.ts --page-start 5
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env["AZTN_DB_PATH"] ?? "data/aztn.db";
const CACHE_DIR = resolve(__dirname, "../data/cache");
const STATE_FILE = resolve(CACHE_DIR, "ingest-state.json");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "https://www.aztn.hr";
const API_BASE = `${BASE_URL}/wp-json/wp/v2`;
const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const USER_AGENT =
  "AnsvarAZTNCrawler/1.0 (https://ansvar.eu; crawler for competition-law research)";

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

interface CliOptions {
  resume: boolean;
  dryRun: boolean;
  force: boolean;
  limit: number;
  pageStart: number;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    resume: false,
    dryRun: false,
    force: false,
    limit: 0,
    pageStart: 1,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--resume":
        opts.resume = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--limit":
        opts.limit = parseInt(args[++i] ?? "0", 10);
        break;
      case "--page-start":
        opts.pageStart = parseInt(args[++i] ?? "1", 10);
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      default:
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// State persistence (for --resume)
// ---------------------------------------------------------------------------

interface IngestState {
  lastPage: number;
  processedIds: number[];
  failedIds: number[];
  stats: {
    decisionsInserted: number;
    mergersInserted: number;
    skipped: number;
    failed: number;
    pdfDownloads: number;
  };
}

function loadState(): IngestState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as IngestState;
    } catch {
      // Corrupted state file — start fresh
    }
  }
  return {
    lastPage: 0,
    processedIds: [],
    failedIds: [],
    stats: { decisionsInserted: 0, mergersInserted: 0, skipped: 0, failed: 0, pdfDownloads: 0 },
  };
}

function saveState(state: IngestState): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP helpers with retry
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string, retries = MAX_RETRIES): Promise<T | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });

      if (res.status === 400 || res.status === 404) {
        // WP returns 400 for invalid page numbers — not an error, just end of data
        return null;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [attempt ${attempt}/${retries}] ${msg}`);
      if (attempt < retries) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  return null;
}

async function fetchHtml(url: string, retries = MAX_RETRIES): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      return await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [attempt ${attempt}/${retries}] ${msg}`);
      if (attempt < retries) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  return null;
}

async function fetchPdfBuffer(url: string, retries = MAX_RETRIES): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,*/*" },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [attempt ${attempt}/${retries}] ${msg}`);
      if (attempt < retries) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// WordPress REST API types
// ---------------------------------------------------------------------------

interface WpDecision {
  id: number;
  date: string;
  slug: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string; protected: boolean };
}

interface WpMedia {
  id: number;
  source_url: string;
  mime_type: string;
  title: { rendered: string };
}

// ---------------------------------------------------------------------------
// Case-number classification
// ---------------------------------------------------------------------------

type DecisionCategory = "competition" | "merger" | "opinion" | "administrative" | "unknown";

interface ClassifiedCase {
  caseNumber: string;
  category: DecisionCategory;
  type: string;
}

function classifyCaseNumber(raw: string): ClassifiedCase {
  const caseNumber = raw.replace(/\\\//g, "/").trim();

  // Merger control — UP/II prefix
  if (/^UP\/II\b/i.test(caseNumber)) {
    return { caseNumber, category: "merger", type: "concentration" };
  }

  // Competition enforcement — UP/I 034-03 or UP/I 030-02
  if (/^UP\/I\s+034-03/i.test(caseNumber)) {
    return { caseNumber, category: "competition", type: "competition_enforcement" };
  }
  if (/^UP\/I\s+030-02/i.test(caseNumber)) {
    return { caseNumber, category: "competition", type: "competition_enforcement" };
  }

  // Opinions — 025-01
  if (/^025-01/i.test(caseNumber)) {
    return { caseNumber, category: "opinion", type: "opinion" };
  }

  // Administrative / procedural — 011-01
  if (/^011-01/i.test(caseNumber)) {
    return { caseNumber, category: "administrative", type: "administrative" };
  }

  // State aid — UP/I 430-01 (we still ingest these as decisions)
  if (/^UP\/I\s+430-01/i.test(caseNumber)) {
    return { caseNumber, category: "competition", type: "state_aid" };
  }

  // Unfair trading practices — UP/I 430-01 with 09 subclass or 031-02
  if (/^031-02/i.test(caseNumber)) {
    return { caseNumber, category: "competition", type: "unfair_trading" };
  }

  return { caseNumber, category: "unknown", type: "unknown" };
}

// ---------------------------------------------------------------------------
// PDF text extraction (lightweight — no external binary dependencies)
// ---------------------------------------------------------------------------

/**
 * Extracts readable text from a PDF buffer using a simple binary parser.
 *
 * This handles the common case of PDFs with embedded text streams. It will
 * not work for scanned-image PDFs (which would need OCR). For AZTN decisions,
 * the majority are text-based PDFs generated from Word documents.
 */
function extractTextFromPdf(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const textChunks: string[] = [];

  // Extract text from stream objects between "stream" and "endstream" markers
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(raw)) !== null) {
    const streamContent = match[1] ?? "";

    // Look for text-showing operators: Tj, TJ, ', "
    // Tj = show string, TJ = show array of strings, ' = move to next line and show, " = set spacing and show
    const textOpRegex = /\(([^)]*)\)\s*Tj|<([0-9A-Fa-f]+)>\s*Tj|\[([^\]]*)\]\s*TJ/g;
    let textMatch: RegExpExecArray | null;

    while ((textMatch = textOpRegex.exec(streamContent)) !== null) {
      if (textMatch[1] !== undefined) {
        // Literal string
        textChunks.push(decodePdfString(textMatch[1]));
      } else if (textMatch[2] !== undefined) {
        // Hex string
        textChunks.push(decodeHexString(textMatch[2]));
      } else if (textMatch[3] !== undefined) {
        // TJ array — extract strings from within
        const tjContent = textMatch[3];
        const innerRegex = /\(([^)]*)\)|<([0-9A-Fa-f]+)>/g;
        let inner: RegExpExecArray | null;
        while ((inner = innerRegex.exec(tjContent)) !== null) {
          if (inner[1] !== undefined) {
            textChunks.push(decodePdfString(inner[1]));
          } else if (inner[2] !== undefined) {
            textChunks.push(decodeHexString(inner[2]));
          }
        }
      }
    }

    // Also try to extract BT...ET blocks with plain text
    const btRegex = /BT\s([\s\S]*?)ET/g;
    let btMatch: RegExpExecArray | null;
    while ((btMatch = btRegex.exec(streamContent)) !== null) {
      const block = btMatch[1] ?? "";
      const lineRegex = /\(([^)]*)\)\s*(?:Tj|'|")/g;
      let lineMatch: RegExpExecArray | null;
      while ((lineMatch = lineRegex.exec(block)) !== null) {
        if (lineMatch[1] !== undefined) {
          textChunks.push(decodePdfString(lineMatch[1]));
        }
      }
    }
  }

  // Deduplicate adjacent identical chunks (common in PDFs)
  const deduped: string[] = [];
  for (const chunk of textChunks) {
    if (chunk.trim() && chunk !== deduped[deduped.length - 1]) {
      deduped.push(chunk);
    }
  }

  return deduped.join(" ").replace(/\s+/g, " ").trim();
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\([()])/g, "$1")
    .replace(/\\(\d{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

function decodeHexString(hex: string): string {
  const chars: string[] = [];
  for (let i = 0; i < hex.length - 1; i += 2) {
    chars.push(String.fromCharCode(parseInt(hex.substring(i, i + 2), 16)));
  }
  return chars.join("");
}

// ---------------------------------------------------------------------------
// Decision page HTML parsing (fallback when no PDF or PDF has no text)
// ---------------------------------------------------------------------------

function parseDecisionPage(html: string): { fullText: string; pdfUrls: string[] } {
  const $ = cheerio.load(html);
  const pdfUrls: string[] = [];

  // Collect PDF download links
  $('a[href$=".pdf"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (href) {
      pdfUrls.push(href.startsWith("http") ? href : `${BASE_URL}${href}`);
    }
  });

  // Extract main content
  const contentSelectors = [
    ".entry-content",
    ".post-content",
    "article .content",
    ".decision-content",
    "main .wpb_text_column",
    "main article",
    "main .entry",
  ];

  let fullText = "";
  for (const selector of contentSelectors) {
    const el = $(selector);
    if (el.length > 0) {
      fullText = el.text().replace(/\s+/g, " ").trim();
      if (fullText.length > 100) break;
    }
  }

  return { fullText, pdfUrls };
}

// ---------------------------------------------------------------------------
// Metadata extraction from text
// ---------------------------------------------------------------------------

interface ParsedDecision {
  parties: string | null;
  summary: string | null;
  outcome: string | null;
  fineAmount: number | null;
  competitionArticles: string | null;
  sector: string | null;
}

interface ParsedMerger {
  acquiringParty: string | null;
  target: string | null;
  summary: string | null;
  outcome: string | null;
  sector: string | null;
  turnover: number | null;
}

function extractDecisionMeta(text: string, caseNumber: string): ParsedDecision {
  const meta: ParsedDecision = {
    parties: null,
    summary: null,
    outcome: null,
    fineAmount: null,
    competitionArticles: null,
    sector: null,
  };

  // Extract fine amounts — look for HRK or EUR amounts
  const finePatterns = [
    /(?:kazn[aeu]|novc[aeo]n[aeiou]\s+kazn[aeu]|glob[aeu])[^0-9]*?([\d.,]+)\s*(?:kuna|HRK|kn)/i,
    /(?:kazn[aeu]|novc[aeo]n[aeiou]\s+kazn[aeu]|glob[aeu])[^0-9]*?([\d.,]+)\s*(?:eura?|EUR)/i,
    /([\d.,]+)\s*(?:kuna|HRK|kn|eura?|EUR)[^a-z]*?(?:kazn|glob)/i,
  ];

  for (const pattern of finePatterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const numStr = match[1].replace(/\./g, "").replace(",", ".");
      const amount = parseFloat(numStr);
      if (!isNaN(amount) && amount > 0) {
        meta.fineAmount = amount;
        break;
      }
    }
  }

  // Extract competition law article references
  const articlePatterns = [
    /(?:cl(?:ank[aeiou])?\.?\s*(\d+)\.?\s*(?:ZZTN|Zakona o zastiti trzisnog natjecanja))/gi,
    /(?:clank[aeiou]?\s+(\d+)\.?\s+(?:stavk[aeiou]?\s+\d+\.?\s+)?ZZTN)/gi,
    /(?:cl\.?\s*(\d+)\.?\s*(?:st\.?\s*\d+\.?\s*)?UFEU)/gi,
    /(?:UFEU[^.]*?cl(?:ank)?\.?\s*(\d+))/gi,
  ];

  const articles: string[] = [];
  for (const pattern of articlePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) {
        const artNum = match[1];
        const context = text.substring(Math.max(0, match.index - 5), match.index + match[0].length + 10);
        if (/ZZTN|Zakon/i.test(context)) {
          articles.push(`ZZTN cl. ${artNum}`);
        } else if (/UFEU/i.test(context)) {
          articles.push(`UFEU cl. ${artNum}`);
        }
      }
    }
  }
  if (articles.length > 0) {
    meta.competitionArticles = [...new Set(articles)].join(", ");
  }

  // Determine outcome from text
  if (meta.fineAmount && meta.fineAmount > 0) {
    meta.outcome = "fine";
  } else if (/obvez[aeiou]|commitments?/i.test(text)) {
    meta.outcome = "remedies";
  } else if (/odbij[aeiou]|odbi(?:jen|la)|dismiss/i.test(text)) {
    meta.outcome = "dismissed";
  } else if (/obustavlja|obustav(?:ljen|ila)|discontinu/i.test(text)) {
    meta.outcome = "discontinued";
  } else if (/utvrdi(?:la)?.*?povred[aeu]|utvrduj[aeiou].*?krsenje/i.test(text)) {
    meta.outcome = "infringement_found";
  } else if (/nije utvrdila.*?povred[aeu]|nije.*?krsenje/i.test(text)) {
    meta.outcome = "no_infringement";
  }

  // Determine decision type from case number and text
  if (/zabranjeni\s+sporazum|kartel|horizontal|dogovor/i.test(text)) {
    meta.sector = inferSector(text);
  } else if (/zloupora[bv]|vladaju[cć]|dominan/i.test(text)) {
    meta.sector = inferSector(text);
  } else if (/vertikalni|distribu(?:cij|ter)/i.test(text)) {
    meta.sector = inferSector(text);
  }

  if (!meta.sector) {
    meta.sector = inferSector(text);
  }

  // Extract summary — first substantial paragraph after header
  const summaryMatch = text.match(
    /(?:(?:Agencija|Vijece).*?(?:utvrdila|donijela|odlucila|rjesava)[^.]*\.\s*)([^.]{50,300}\.)/i,
  );
  if (summaryMatch?.[1]) {
    meta.summary = summaryMatch[1].trim();
  }

  return meta;
}

function extractMergerMeta(text: string): ParsedMerger {
  const meta: ParsedMerger = {
    acquiringParty: null,
    target: null,
    summary: null,
    outcome: null,
    sector: null,
    turnover: null,
  };

  // Outcome determination for mergers
  if (/odobr(?:ava|ila|eno)\s+(?:bez\s+)?uvjet/i.test(text)) {
    meta.outcome = "approved_with_conditions";
  } else if (/odobr(?:ava|ila|eno)/i.test(text)) {
    meta.outcome = "approved";
  } else if (/zabran(?:juje|ila|jeno)/i.test(text)) {
    meta.outcome = "prohibited";
  } else if (/faz[aeiou]\s*II|produblj/i.test(text)) {
    meta.outcome = "under_review";
  } else if (/povuc(?:en|la)|povlac/i.test(text)) {
    meta.outcome = "withdrawn";
  }

  // Turnover extraction
  const turnoverMatch = text.match(
    /(?:promet|prihod|turnover)[^0-9]*?([\d.,]+)\s*(?:milij[aou]na?|mil\.?)\s*(?:kuna|HRK|eura?|EUR)/i,
  );
  if (turnoverMatch?.[1]) {
    const numStr = turnoverMatch[1].replace(/\./g, "").replace(",", ".");
    const amount = parseFloat(numStr);
    if (!isNaN(amount) && amount > 0) {
      meta.turnover = amount * 1_000_000; // Convert millions to base unit
    }
  }

  meta.sector = inferSector(text);

  return meta;
}

function inferSector(text: string): string | null {
  const sectorMap: [RegExp, string][] = [
    [/energij[aeiou]|elektric|plin|gas\b|struj/i, "energy"],
    [/telekomun|telekom\b|mobiln|internet\b|elektronick[aeiou]\s+komunik/i, "telecommunications"],
    [/bank[aeiou]|kredit|financij/i, "banking"],
    [/osiguran/i, "insurance"],
    [/farmaceut|lijek|ljekarn/i, "pharmaceuticals"],
    [/prehrambeni|hran[aeiou]|mljekar|mlijeko|meso|pecivo/i, "food"],
    [/maloprodaj|supermarket|trgovin|prodavaonic/i, "retail"],
    [/građevin|nekretnin|cement|beton|gradjev/i, "construction"],
    [/turizam|turistick|smjestaj|hotel/i, "tourism"],
    [/promet|prijevoz|transport|zeljeznic|autobusn/i, "transport"],
    [/medij[aeiou]|tiskov|televizij|radio\b|izdavac/i, "media"],
    [/digital|online|platforma|internet/i, "digital"],
    [/automobil|vozil/i, "automotive"],
    [/poljoprivred|agrar/i, "agriculture"],
    [/zdravstv|bolnic|medicinsk/i, "healthcare"],
    [/komunaln|vodn[aeiou]|otpad/i, "utilities"],
    [/javna nabava|javnog nadruc/i, "public_procurement"],
    [/odvjetni|pravni|savjetovan/i, "professional_services"],
  ];

  for (const [pattern, sector] of sectorMap) {
    if (pattern.test(text)) {
      return sector;
    }
  }

  return null;
}

// Determine competition enforcement subtype from text
function inferCompetitionType(text: string): string {
  if (/zabranjeni\s+sporazum|kartel|horizontal|fiksiran|podjel[aeiou]\s+trzist/i.test(text)) {
    return "cartel";
  }
  if (/vertikalni\s+sporazum|RPM|odrzavan[aeiou]\s+preprodajn|ekskluzivn/i.test(text)) {
    return "vertical_agreement";
  }
  if (/zloupora[bv]|vladaju[cć]|dominantn|isklju[cč]iv/i.test(text)) {
    return "abuse_of_dominance";
  }
  if (/istrazivanje\s+trzist|sektorsk[aeiou]\s+istrazivanje/i.test(text)) {
    return "sector_inquiry";
  }
  return "competition_enforcement";
}

// ---------------------------------------------------------------------------
// Sector registry
// ---------------------------------------------------------------------------

const SECTOR_REGISTRY: Record<string, { name: string; name_en: string }> = {
  energy: { name: "Energetika", name_en: "Energy" },
  telecommunications: { name: "Telekomunikacije", name_en: "Telecommunications" },
  banking: { name: "Bankarstvo", name_en: "Banking" },
  insurance: { name: "Osiguranje", name_en: "Insurance" },
  pharmaceuticals: { name: "Farmaceutska industrija", name_en: "Pharmaceuticals" },
  food: { name: "Prehrambena industrija", name_en: "Food" },
  retail: { name: "Maloprodaja", name_en: "Retail" },
  construction: { name: "Gradevinarstvo", name_en: "Construction" },
  tourism: { name: "Turizam", name_en: "Tourism" },
  transport: { name: "Promet i prijevoz", name_en: "Transport" },
  media: { name: "Mediji", name_en: "Media" },
  digital: { name: "Digitalno trziste", name_en: "Digital markets" },
  automotive: { name: "Automobilska industrija", name_en: "Automotive" },
  agriculture: { name: "Poljoprivreda", name_en: "Agriculture" },
  healthcare: { name: "Zdravstvo", name_en: "Healthcare" },
  utilities: { name: "Komunalne usluge", name_en: "Utilities" },
  public_procurement: { name: "Javna nabava", name_en: "Public procurement" },
  professional_services: { name: "Profesionalne usluge", name_en: "Professional services" },
};

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();
  console.log("AZTN Decision Ingestion Crawler");
  console.log("================================");
  console.log(`  resume:     ${opts.resume}`);
  console.log(`  dry-run:    ${opts.dryRun}`);
  console.log(`  force:      ${opts.force}`);
  console.log(`  limit:      ${opts.limit || "no limit"}`);
  console.log(`  page-start: ${opts.pageStart}`);
  console.log(`  db:         ${DB_PATH}`);
  console.log();

  // ── Prepare DB ──────────────────────────────────────────────────────────
  if (!opts.dryRun) {
    const dbDir = dirname(DB_PATH);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    if (opts.force && existsSync(DB_PATH)) {
      unlinkSync(DB_PATH);
      console.log(`Deleted existing DB: ${DB_PATH}`);
    }
  }

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  const state = opts.resume ? loadState() : loadState(); // Always load; --resume skips already-processed
  const processedSet = new Set(state.processedIds);

  let db: Database.Database | null = null;
  if (!opts.dryRun) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
  }

  // Prepared statements
  const insertDecision = db?.prepare(`
    INSERT OR REPLACE INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, competition_articles, status)
    VALUES
      (@case_number, @title, @date, @type, @sector, @parties, @summary, @full_text, @outcome, @fine_amount, @competition_articles, @status)
  `);

  const insertMerger = db?.prepare(`
    INSERT OR REPLACE INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES
      (@case_number, @title, @date, @sector, @acquiring_party, @target, @summary, @full_text, @outcome, @turnover)
  `);

  const sectorCounts: Record<string, { decisions: number; mergers: number }> = {};

  // ── Phase 1: Index ──────────────────────────────────────────────────────
  console.log("=== Phase 1: Fetching decision index via WP REST API ===\n");

  const allDecisions: WpDecision[] = [];
  let page = opts.resume && state.lastPage > 0 ? state.lastPage : opts.pageStart;
  let totalFetched = 0;

  while (true) {
    const url = `${API_BASE}/decision?per_page=${PAGE_SIZE}&page=${page}&_fields=id,date,slug,link,title,content`;
    console.log(`  Page ${page}: fetching...`);

    const results = await fetchJson<WpDecision[]>(url);
    if (!results || results.length === 0) {
      console.log(`  Page ${page}: empty — end of index.`);
      break;
    }

    console.log(`  Page ${page}: ${results.length} entries`);
    allDecisions.push(...results);
    totalFetched += results.length;

    state.lastPage = page;
    saveState(state);

    if (opts.limit > 0 && totalFetched >= opts.limit) {
      console.log(`  Reached limit of ${opts.limit} entries.`);
      break;
    }

    if (results.length < PAGE_SIZE) {
      console.log(`  Page ${page}: partial page — end of index.`);
      break;
    }

    page++;
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n  Total index entries: ${allDecisions.length}\n`);

  // Apply limit
  const toProcess = opts.limit > 0 ? allDecisions.slice(0, opts.limit) : allDecisions;

  // ── Phase 2 & 3: Fetch media + content for each decision ───────────────
  console.log("=== Phase 2-3: Fetching content for each decision ===\n");

  let processed = 0;
  const errors: Array<{ id: number; slug: string; error: string }> = [];

  for (const wpDec of toProcess) {
    processed++;

    // Skip if already processed (resume mode)
    if (opts.resume && processedSet.has(wpDec.id)) {
      if (opts.verbose) console.log(`  [${processed}/${toProcess.length}] SKIP (already processed): ${wpDec.title.rendered}`);
      state.stats.skipped++;
      continue;
    }

    const classified = classifyCaseNumber(wpDec.title.rendered);
    console.log(
      `  [${processed}/${toProcess.length}] ${classified.caseNumber} (${classified.category}) ...`,
    );

    try {
      // ── Fetch attached PDF ────────────────────────────────────────────
      let fullText = "";
      const mediaUrl = `${API_BASE}/media?parent=${wpDec.id}&_fields=id,source_url,mime_type,title`;

      await sleep(RATE_LIMIT_MS);
      const mediaItems = await fetchJson<WpMedia[]>(mediaUrl);

      let pdfUrl: string | null = null;
      if (mediaItems && mediaItems.length > 0) {
        const pdfMedia = mediaItems.find((m) => m.mime_type === "application/pdf");
        if (pdfMedia) {
          pdfUrl = pdfMedia.source_url;
        }
      }

      // Try PDF extraction first
      if (pdfUrl) {
        if (opts.verbose) console.log(`    PDF: ${pdfUrl}`);

        if (!opts.dryRun) {
          await sleep(RATE_LIMIT_MS);
          const pdfBuf = await fetchPdfBuffer(pdfUrl);
          if (pdfBuf) {
            state.stats.pdfDownloads++;
            fullText = extractTextFromPdf(pdfBuf);
            if (opts.verbose) {
              console.log(`    Extracted ${fullText.length} chars from PDF`);
            }
          }
        } else {
          console.log(`    [dry-run] Would download PDF: ${pdfUrl}`);
        }
      }

      // Fallback: fetch decision HTML page
      if (!fullText || fullText.length < 100) {
        if (opts.verbose) console.log(`    Fetching HTML page: ${wpDec.link}`);

        await sleep(RATE_LIMIT_MS);
        const html = await fetchHtml(wpDec.link);
        if (html) {
          const parsed = parseDecisionPage(html);
          if (parsed.fullText.length > fullText.length) {
            fullText = parsed.fullText;
          }

          // If HTML had PDF links we haven't tried, fetch those
          if (fullText.length < 100 && parsed.pdfUrls.length > 0 && !opts.dryRun) {
            for (const url of parsed.pdfUrls) {
              if (url === pdfUrl) continue; // Already tried
              if (opts.verbose) console.log(`    Additional PDF: ${url}`);
              await sleep(RATE_LIMIT_MS);
              const buf = await fetchPdfBuffer(url);
              if (buf) {
                state.stats.pdfDownloads++;
                const extracted = extractTextFromPdf(buf);
                if (extracted.length > fullText.length) {
                  fullText = extracted;
                }
              }
              if (fullText.length >= 100) break;
            }
          }
        }
      }

      // Use WP content if available and longer
      const wpContent = wpDec.content.rendered
        ? cheerio.load(wpDec.content.rendered).text().trim()
        : "";
      if (wpContent.length > fullText.length) {
        fullText = wpContent;
      }

      // Minimum content threshold
      if (!fullText || fullText.length < 20) {
        fullText = `Odluka ${classified.caseNumber} — tekst odluke nije dostupan u digitalnom obliku.`;
      }

      // ── Insert into DB ──────────────────────────────────────────────────
      if (!opts.dryRun) {
        const dateStr = wpDec.date ? wpDec.date.split("T")[0] ?? null : null;

        if (classified.category === "merger") {
          const meta = extractMergerMeta(fullText);
          insertMerger?.run({
            case_number: classified.caseNumber,
            title: classified.caseNumber,
            date: dateStr,
            sector: meta.sector,
            acquiring_party: meta.acquiringParty,
            target: meta.target,
            summary: meta.summary,
            full_text: fullText,
            outcome: meta.outcome,
            turnover: meta.turnover,
          });
          state.stats.mergersInserted++;

          if (meta.sector) {
            sectorCounts[meta.sector] = sectorCounts[meta.sector] ?? { decisions: 0, mergers: 0 };
            sectorCounts[meta.sector]!.mergers++;
          }
        } else {
          const meta = extractDecisionMeta(fullText, classified.caseNumber);
          const type =
            classified.type === "competition_enforcement"
              ? inferCompetitionType(fullText)
              : classified.type;

          insertDecision?.run({
            case_number: classified.caseNumber,
            title: classified.caseNumber,
            date: dateStr,
            type,
            sector: meta.sector,
            parties: meta.parties,
            summary: meta.summary,
            full_text: fullText,
            outcome: meta.outcome,
            fine_amount: meta.fineAmount,
            competition_articles: meta.competitionArticles,
            status: "final",
          });
          state.stats.decisionsInserted++;

          if (meta.sector) {
            sectorCounts[meta.sector] = sectorCounts[meta.sector] ?? { decisions: 0, mergers: 0 };
            sectorCounts[meta.sector]!.decisions++;
          }
        }
      }

      // Mark as processed
      state.processedIds.push(wpDec.id);
      processedSet.add(wpDec.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    ERROR: ${msg}`);
      errors.push({ id: wpDec.id, slug: wpDec.slug, error: msg });
      state.failedIds.push(wpDec.id);
      state.stats.failed++;
    }

    // Persist state periodically
    if (processed % 25 === 0) {
      saveState(state);
    }
  }

  // ── Phase 4: Populate sectors table ─────────────────────────────────────
  if (!opts.dryRun && db) {
    console.log("\n=== Phase 4: Populating sectors table ===\n");

    const insertSector = db.prepare(`
      INSERT OR REPLACE INTO sectors (id, name, name_en, description, decision_count, merger_count)
      VALUES (@id, @name, @name_en, @description, @decision_count, @merger_count)
    `);

    for (const [sectorId, counts] of Object.entries(sectorCounts)) {
      const info = SECTOR_REGISTRY[sectorId];
      if (info) {
        insertSector.run({
          id: sectorId,
          name: info.name,
          name_en: info.name_en,
          description: null,
          decision_count: counts.decisions,
          merger_count: counts.mergers,
        });
        console.log(
          `  ${sectorId}: ${counts.decisions} decisions, ${counts.mergers} mergers`,
        );
      }
    }
  }

  // ── Final state save and report ─────────────────────────────────────────
  saveState(state);

  console.log("\n================================");
  console.log("Ingestion complete.");
  console.log(`  Decisions inserted: ${state.stats.decisionsInserted}`);
  console.log(`  Mergers inserted:   ${state.stats.mergersInserted}`);
  console.log(`  Skipped (resume):   ${state.stats.skipped}`);
  console.log(`  Failed:             ${state.stats.failed}`);
  console.log(`  PDFs downloaded:    ${state.stats.pdfDownloads}`);

  if (errors.length > 0) {
    console.log(`\nFailed entries (${errors.length}):`);
    for (const e of errors) {
      console.log(`  - [${e.id}] ${e.slug}: ${e.error}`);
    }
  }

  if (!opts.dryRun) {
    const decisionCount = db?.prepare("SELECT COUNT(*) AS cnt FROM decisions").get() as
      | { cnt: number }
      | undefined;
    const mergerCount = db?.prepare("SELECT COUNT(*) AS cnt FROM mergers").get() as
      | { cnt: number }
      | undefined;
    const sectorCount = db?.prepare("SELECT COUNT(*) AS cnt FROM sectors").get() as
      | { cnt: number }
      | undefined;

    console.log(`\nDB totals: ${decisionCount?.cnt ?? 0} decisions, ${mergerCount?.cnt ?? 0} mergers, ${sectorCount?.cnt ?? 0} sectors`);
    console.log(`DB path: ${DB_PATH}`);
  }

  db?.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
