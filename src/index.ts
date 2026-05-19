#!/usr/bin/env node

/**
 * Croatian Competition MCP — stdio entry point.
 *
 * Provides MCP tools for querying AZTN (Agencija za zaštitu tržišnog
 * natjecanja — Croatian Competition Agency) decisions, merger control cases,
 * and sector enforcement activity under Croatian competition law (ZZTN).
 *
 * Tool prefix: hr_comp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
  listSources,
  getDataFreshness,
  getDataAge,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "croatian-competition-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "hr_comp_search_decisions",
    description:
      "Full-text search across AZTN competition enforcement decisions. Covers abuse of dominance, cartel enforcement, and sector inquiries under Croatian competition law (Zakon o zaštiti tržišnog natjecanja — ZZTN). Returns matching decisions with case number, parties, sector, outcome, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'zlouporaba vladajućeg položaja', 'kartel', 'zaštita tržišnog natjecanja')",
        },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "sector_inquiry", "unfair_competition"],
          description: "Filter by case type. Optional.",
        },
        sector: {
          type: "string",
          description: "Filter by industry sector (e.g., 'energy', 'telecommunications', 'retail'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["infringement", "commitment", "no_infringement", "fine"],
          description: "Filter by decision outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "hr_comp_get_decision",
    description:
      "Get a specific AZTN competition decision by case number (e.g., 'AZTN/001/2024', 'AZTN/050/2023').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "AZTN case number",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "hr_comp_search_mergers",
    description:
      "Search AZTN merger control decisions. Returns merger cases with acquiring party, target, sector, and clearance outcome under Croatian merger control rules (ZZTN).",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'koncentracija poduzetnika', 'preuzimanje', 'energija')",
        },
        sector: {
          type: "string",
          description: "Filter by industry sector. Optional.",
        },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_with_conditions", "blocked", "withdrawn"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "hr_comp_get_merger",
    description:
      "Get a specific AZTN merger control decision by case number (e.g., 'AZTN/M/10/2024').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "AZTN merger case number",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "hr_comp_list_sectors",
    description:
      "List all industry sectors with AZTN enforcement activity covered in this MCP, with decision and merger counts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hr_comp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hr_comp_list_sources",
    description:
      "List authoritative data sources used by this MCP server, with provenance metadata including URL, jurisdiction, and license.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hr_comp_check_data_freshness",
    description:
      "Check the freshness of the underlying AZTN data. Returns record counts and the latest decision/merger date ingested, so callers can assess how current the data is.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "sector_inquiry", "unfair_competition"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["infringement", "commitment", "no_infringement", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_with_conditions", "blocked", "withdrawn"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- Helper ------------------------------------------------------------------

const META = {
  disclaimer:
    "Data sourced from AZTN (Croatian Competition Agency). For research use only — not legal advice. Verify all references against primary sources before making compliance decisions.",
  source_url: "https://www.aztn.hr/",
  copyright: "AZTN — Agencija za zaštitu tržišnog natjecanja",
};

function textContent(data: unknown) {
  const dataAge = getDataAge();
  const meta = { ...META, data_age: dataAge };
  const payload =
    typeof data === "object" && data !== null
      ? { _meta: meta, ...(data as object) }
      : { _meta: meta, value: data };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "hr_comp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "hr_comp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.case_number);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.case_number}`);
        }
        return textContent({
          ...(typeof decision === 'object' ? decision : { data: decision }),
          _citation: buildCitation(
            (decision as any).case_number || parsed.case_number,
            (decision as any).title || (decision as any).subject || '',
            'hr_comp_get_decision',
            { case_number: parsed.case_number },
            (decision as any).url || null,
          ),
        });
      }

      case "hr_comp_search_mergers": {
        const parsed = SearchMergersArgs.parse(args);
        const results = searchMergers({
          query: parsed.query,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "hr_comp_get_merger": {
        const parsed = GetMergerArgs.parse(args);
        const merger = getMerger(parsed.case_number);
        if (!merger) {
          return errorContent(`Merger decision not found: ${parsed.case_number}`);
        }
        return textContent({
          ...(typeof merger === 'object' ? merger : { data: merger }),
          _citation: buildCitation(
            (merger as any).case_number || parsed.case_number,
            (merger as any).title || (merger as any).subject || '',
            'hr_comp_get_merger',
            { case_number: parsed.case_number },
            (merger as any).url || null,
          ),
        });
      }

      case "hr_comp_list_sectors": {
        const sectors = listSectors();
        return textContent({ sectors, count: sectors.length });
      }

      case "hr_comp_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "AZTN (Agencija za zaštitu tržišnog natjecanja — Croatian Competition Agency) MCP server. Provides access to competition enforcement decisions, merger control cases, and sector inquiries under Croatian competition law (Zakon o zaštiti tržišnog natjecanja — ZZTN).",
          data_source: "AZTN (https://www.aztn.hr/)",
          coverage: {
            decisions: "AZTN abuse of dominance, cartel, and sector inquiry decisions",
            mergers: "AZTN merger control decisions under ZZTN",
            sectors: "Sectors with AZTN enforcement activity",
          },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      case "hr_comp_list_sources": {
        const sources = listSources();
        return textContent({ sources, count: sources.length });
      }

      case "hr_comp_check_data_freshness": {
        const freshness = getDataFreshness();
        return textContent(freshness);
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
