import { supa } from "./supabaseClient.js";

const PAGE_SIZE = 500;
const ID_BATCH_SIZE = 100;

async function readAll(table, filter = (query) => query, orderColumn = "id") {
  const rows = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await filter(supa.from(table).select("*"))
      .order(orderColumn, { ascending: true })
      .range(start, start + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} : ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE_SIZE) return rows;
  }
}

async function readByIds(table, column, ids) {
  const rows = [];
  for (let start = 0; start < ids.length; start += ID_BATCH_SIZE) {
    const batch = ids.slice(start, start + ID_BATCH_SIZE);
    rows.push(...await readAll(table, (query) => query.in(column, batch)));
  }
  return rows;
}

function excelValue(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && /^[\s]*[=+\-@\t\r\n]/.test(value)) return `'${value}`;
  return value;
}

function addSheet(workbook, name, rows, headers) {
  const columns = [...new Set([...headers, ...rows.flatMap((row) => Object.keys(row))])];
  const values = rows.map((row) => Object.fromEntries(columns.map((column) => [column, excelValue(row[column])])));
  const sheet = window.XLSX.utils.json_to_sheet(values, { header: columns });
  sheet["!cols"] = columns.map((column) => ({ wch: Math.min(42, Math.max(14, column.length + 3)) }));
  window.XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function filenameForCabinet(cabinet, now = new Date()) {
  const location = String(cabinet.location ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sans-emplacement";
  const two = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `sesame_cabinet-${cabinet.id}_${location}_${stamp}.xlsx`;
}

export async function exportCabinetWorkbook(cabinetId) {
  if (!window.XLSX) throw new Error("Le module Excel n'est pas chargé. Recharge la page et réessaie.");
  const id = Number(cabinetId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Armoire invalide.");

  const [cabinets, keys, devices, keyrings, managers] = await Promise.all([
    readAll("cabinets", (query) => query.eq("id", id)),
    readAll("keys", (query) => query.eq("cabinet_id", id)),
    readAll("devices", (query) => query.eq("cabinet_id", id)),
    readAll("keyrings", (query) => query.eq("cabinet_id", id)),
    readAll("cabinet_managers", (query) => query.eq("cabinet_id", id), "user_id"),
  ]);
  const cabinet = cabinets[0];
  if (!cabinet) throw new Error("Armoire introuvable ou accès refusé.");

  const keyIds = keys.map((row) => row.id);
  const deviceIds = devices.map((row) => row.id);
  const [keyLoans, deviceLoans, keyMissing, deviceMissing, photos] = await Promise.all([
    readByIds("loans", "key_id", keyIds),
    readByIds("loans", "device_id", deviceIds),
    readByIds("keys_missing", "key_id", keyIds),
    readByIds("devices_missing", "device_id", deviceIds),
    readByIds("equipment_photos", "device_id", deviceIds),
  ]);
  const loans = [...keyLoans, ...deviceLoans];
  const missing = [...keyMissing.map((row) => ({ type: "clé", ...row })), ...deviceMissing.map((row) => ({ type: "appareil", ...row }))];
  const personIds = [...new Set([
    ...loans.map((row) => row.borrower_id),
    ...missing.flatMap((row) => [row.reported_by, row.found_by]),
    ...managers.flatMap((row) => [row.user_id, row.created_by]),
  ].filter(Boolean))];
  const profiles = await readByIds("user_profiles", "id", personIds);
  const names = new Map(profiles.map((row) => [row.id, row.display_name || row.id]));
  const nameFor = (personId) => names.get(personId) || "";

  const workbook = window.XLSX.utils.book_new();
  addSheet(workbook, "Armoire", [cabinet], ["id", "name", "location", "cabinet_type"]);
  addSheet(workbook, "Clés", keys, ["id", "cabinet_id", "hook_no", "key_no", "is_missing"]);
  addSheet(workbook, "Appareils", devices, ["id", "cabinet_id", "slot_code", "inventory_number", "is_missing"]);
  addSheet(workbook, "Trousseaux", keyrings, ["id", "cabinet_id", "hook_no", "ring_code"]);
  addSheet(workbook, "Emprunts", loans.map((row) => ({ ...row, emprunteur: nameFor(row.borrower_id) || row.borrower_name || "" })), ["id", "key_id", "device_id", "emprunteur", "loaned_at", "returned_at"]);
  addSheet(workbook, "Signalements", missing.map((row) => ({ ...row, signale_par: nameFor(row.reported_by), retrouve_par: nameFor(row.found_by) })), ["type", "key_id", "device_id", "signale_par", "reported_at", "found_at"]);
  addSheet(workbook, "Photos", photos, ["id", "device_id", "original_name", "storage_path"]);
  addSheet(workbook, "Responsables", managers.map((row) => ({ ...row, nom: nameFor(row.user_id) })), ["cabinet_id", "user_id", "nom", "created_at"]);

  const filename = filenameForCabinet(cabinet);
  window.XLSX.writeFile(workbook, filename, { compression: true });
  return filename;
}
