import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";
const DB_PATH = process.env["AZTN_DB_PATH"] ?? "data/aztn.db";
const force = process.argv.includes("--force");
const dir = dirname(DB_PATH);
if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log("Deleted " + DB_PATH);
}
const db = new Database(DB_PATH);
db.exec(SCHEMA_SQL);
const decisions = [
    { case_number: "AZTN-UP/I-033/2024", title: "Kartel distributera gradevinskog materijala", date: "2024-04-05", type: "cartel", sector: "retail", parties: "Gradjevinski materijal Alfa d.o.o.; Distribucija Beta d.d.; Trgovina Gamma d.o.o.", summary: "AZTN kaznio tri distributera gradevinskog materijala za zabranjeni sporazum o podjeli trzista i koordinaciji cijena.", full_text: "Odluka AZTN-UP/I-033/2024\n\nTri distributera zakljucila su kartelni sporazum protivno cl. 8. ZZTN-a i cl. 101. UFEU-a. Koordinirali su cijene i dijelili trzista 2 godine, sto je dovelo do porasta cijena 10-15%.\n\nKazna: 12.000.000 HRK.", outcome: "fine", fine_amount: 12000000, competition_articles: "ZZTN čl. 8, UFEU čl. 101", status: "final" },
    { case_number: "AZTN-UP/I-047/2024", title: "Zlouporaba vladajuceg polozaja na trzistu distribucije plina", date: "2024-06-18", type: "abuse_of_dominance", sector: "energy", parties: "Distributer plina d.d.", summary: "AZTN kaznio dominantnog distributera plina zbog primjene diskriminatornih uvjeta prema neovisnim opskrbljivacima.", full_text: "Odluka AZTN-UP/I-047/2024\n\nDrustvo s vladajucim polozajem primjenjivalo je razlicite tehnicke i komercijalne uvjete prema neovisnim opskrbljivacima, istiskujuci ih s trzista.\n\nKazna: 19.000.000 HRK i nediskriminatorni uvjeti pristupa.", outcome: "fine", fine_amount: 19000000, competition_articles: "ZZTN čl. 13, UFEU čl. 102", status: "final" },
    { case_number: "AZTN-IZ/003/2024", title: "Istrazivanje trzista turizma i smjestajnih platformi", date: "2024-08-12", type: "sector_inquiry", sector: "tourism", parties: "Platforme za kratkorocni smjestaj u Hrvatskoj", summary: "Istrazivanje trzista turizma s fokusom na uvjete poslovanja platformi kratkorocnog smjestaja.", full_text: "Pokretanje AZTN-IZ/003/2024\n\nPodrucja: uvjeti platformi, paritet cijena, utjecaj na dostupnost smjestaja, polozaj OTA vs. hoteli.\n\nTrajanje: 18 mjeseci.", outcome: "ongoing", fine_amount: null, competition_articles: "ZZTN čl. 41", status: "ongoing" },
    { case_number: "AZTN-UP/I-058/2024", title: "Koordinacija prodajnih uvjeta lijekova bez recepta", date: "2024-10-01", type: "cartel", sector: "pharmaceuticals", parties: "Velodistributer lijekova d.o.o.; Ljekarnicka mreza d.d.", summary: "Zabranjeni sporazum o minimalnim maloprodajnim cijenama OTC lijekova.", full_text: "Odluka AZTN-UP/I-058/2024\n\nRPM za OTC lijekove ogranicavao je cjenovno natjecanje na razini maloprodaje.\n\nKazna: 5.500.000 HRK.", outcome: "fine", fine_amount: 5500000, competition_articles: "ZZTN čl. 8", status: "final" },
    { case_number: "AZTN-UP/I-071/2024", title: "Nepravicni uvjeti na digitalnom trzistu", date: "2024-11-28", type: "abuse_of_dominance", sector: "retail", parties: "Online trznica HR d.o.o.", summary: "AZTN prihvatio obveze dominantne online trznice o ukidanju nepravicnih uvjeta prema prodavacima trecih strana.", full_text: "Odluka AZTN-UP/I-071/2024\n\nDominantna online trznica primjenjivala je jednostrano promjenjive uvjete, prekomjerne provizije i ekskluzivnost.\n\nObveze: transparentni uvjeti, zabrana retroaktivnih provizija, neovisni mehanizam rjesavanja sporova.", outcome: "remedies", fine_amount: null, competition_articles: "ZZTN čl. 13", status: "final" },
];
const mergers = [
    { case_number: "AZTN-UP/II-012/2024", title: "Koncentracija u prehrambenom maloprodajnom sektoru", date: "2024-05-10", sector: "retail", acquiring_party: "Supermarket Alfa d.d.", target: "Maloprodaja Beta d.o.o.", summary: "Odobreno uz uvjete - prodaja prodavaonica u tri zupanije gdje bi fuzija stvorila vladajuci polozaj.", full_text: "Odluka AZTN-UP/II-012/2024\n\nSpajanjem nastaje subjekt s trzisnim udjelom iznad 40% u tri zupanije.\n\nUvjeti: prodaja 8 prodavaonica u Splitsko-dalmatinskoj, Primorsko-goranskoj i Zadarskoj zupaniji.", outcome: "approved_with_conditions", turnover: null },
    { case_number: "AZTN-UP/II-021/2024", title: "Preuzimanje regionalnog telekomunikacijskog operatera", date: "2024-07-22", sector: "telecommunications", acquiring_party: "Telekom HR d.d.", target: "RegioNet d.o.o.", summary: "Odobreno bez uvjeta - ograniceni trzisni udio ciljne tvrtke.", full_text: "Odluka AZTN-UP/II-021/2024\n\nRegioNet ima trzisni udio ispod 5%. Horizontalna preklapanja minimalna.\n\nKoncentracija odobrena bez uvjeta.", outcome: "approved", turnover: null },
    { case_number: "AZTN-UP/II-035/2024", title: "Fuzija u bankarskom sektoru", date: "2024-10-20", sector: "banking", acquiring_party: "Banka Gamma d.d.", target: "Financijska institucija Delta d.d.", summary: "Produbljena analiza fuzije dviju banaka - utjecaj na stambene kredite i kredite za MSP.", full_text: "Pokretanje Faze II AZTN-UP/II-035/2024\n\nKombinirani trzisni udio prelazi 25% u stambenim kreditima. Zabrinutost koordinacijskih ucinaka za MSP.\n\nOcekivana odluka u 90 radnih dana.", outcome: "under_review", turnover: null },
];
const iD = db.prepare("INSERT OR REPLACE INTO decisions (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, competition_articles, status) VALUES (@case_number, @title, @date, @type, @sector, @parties, @summary, @full_text, @outcome, @fine_amount, @competition_articles, @status)");
const iM = db.prepare("INSERT OR REPLACE INTO mergers (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover) VALUES (@case_number, @title, @date, @sector, @acquiring_party, @target, @summary, @full_text, @outcome, @turnover)");
for (const d of decisions)
    iD.run(d);
for (const m of mergers)
    iM.run(m);
console.log("Seeded " + decisions.length + " decisions, " + mergers.length + " mergers into " + DB_PATH);
db.close();
