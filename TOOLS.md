# Tool Reference — Croatian Competition MCP

All tools use the prefix `hr_comp_`. All responses include a `_meta` block with disclaimer, source URL, copyright, and data age.

---

## hr_comp_search_decisions

Full-text search across AZTN competition enforcement decisions.

**Inputs**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `query`   | string | Yes      | Search query in Croatian or English (e.g., `zlouporaba vladajućeg položaja`, `kartel`) |
| `type`    | enum   | No       | `abuse_of_dominance` \| `cartel` \| `sector_inquiry` \| `unfair_competition` |
| `sector`  | string | No       | Industry sector filter (e.g., `energy`, `telecommunications`) |
| `outcome` | enum   | No       | `infringement` \| `commitment` \| `no_infringement` \| `fine` |
| `limit`   | number | No       | Max results (1–100, default 20) |

**Output:** `{ _meta, results: Decision[], count: number }`

**Example query:** `hr_comp_search_decisions({ query: "kartel" })`

---

## hr_comp_get_decision

Retrieve a single AZTN enforcement decision by case number.

**Inputs**

| Parameter     | Type   | Required | Description |
|---------------|--------|----------|-------------|
| `case_number` | string | Yes      | AZTN case number (e.g., `AZTN/001/2024`) |

**Output:** `{ _meta, ...Decision }` or error if not found.

---

## hr_comp_search_mergers

Search AZTN merger control decisions.

**Inputs**

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `query`   | string | Yes      | Search query (e.g., `koncentracija poduzetnika`, `preuzimanje`) |
| `sector`  | string | No       | Industry sector filter |
| `outcome` | enum   | No       | `cleared` \| `cleared_with_conditions` \| `blocked` \| `withdrawn` |
| `limit`   | number | No       | Max results (1–100, default 20) |

**Output:** `{ _meta, results: Merger[], count: number }`

---

## hr_comp_get_merger

Retrieve a single AZTN merger decision by case number.

**Inputs**

| Parameter     | Type   | Required | Description |
|---------------|--------|----------|-------------|
| `case_number` | string | Yes      | AZTN merger case number (e.g., `AZTN/M/10/2024`) |

**Output:** `{ _meta, ...Merger }` or error if not found.

---

## hr_comp_list_sectors

List all industry sectors with AZTN enforcement activity, with decision and merger counts.

**Inputs:** None

**Output:** `{ _meta, sectors: Sector[], count: number }`

---

## hr_comp_about

Return metadata about this MCP server: version, data source, coverage summary, and tool list.

**Inputs:** None

**Output:** `{ _meta, name, version, description, data_source, coverage, tools }`

---

## hr_comp_list_sources

List authoritative data sources used by this MCP, with provenance metadata.

**Inputs:** None

**Output:** `{ _meta, sources: SourceInfo[], count: number }`

Each `SourceInfo` includes: `id`, `name`, `name_en`, `url`, `description`, `jurisdiction`, `license`.

---

## hr_comp_check_data_freshness

Check how current the underlying data is.

**Inputs:** None

**Output:**
```json
{
  "_meta": { ... },
  "decisions": { "count": 42, "latest_date": "2024-11-15" },
  "mergers":   { "count": 18, "latest_date": "2024-10-03" },
  "checked_at": "2026-04-05T12:00:00.000Z"
}
```
