import zlib from "node:zlib";
import { InputError } from "../utils.js";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIR = 0x06054b50;

function findEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIR) return i;
  }
  throw new InputError("Invalid XLSX file: central directory was not found");
}

function unzipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_HEADER) {
      throw new InputError("Invalid XLSX file: malformed zip directory");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const filenameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + filenameLength).toString("utf8");

    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER) {
      throw new InputError("Invalid XLSX file: malformed zip entry");
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = zlib.inflateRawSync(compressed);
    else throw new InputError(`Unsupported XLSX compression method ${method}`);
    files.set(name, content.toString("utf8"));
    offset += 46 + filenameLength + extraLength + commentLength;
  }

  return files;
}

function xmlDecode(value = "") {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function readSharedStrings(xml = "") {
  const strings = [];
  const matches = xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g);
  for (const match of matches) {
    const textParts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => xmlDecode(part[1]));
    strings.push(textParts.join(""));
  }
  return strings;
}

function columnIndex(cellRef = "") {
  const letters = cellRef.replace(/[^A-Z]/gi, "").toUpperCase();
  let total = 0;
  for (const letter of letters) total = total * 26 + letter.charCodeAt(0) - 64;
  return total - 1;
}

function readCellValue(cellXml, sharedStrings) {
  const type = /<c\b[^>]*\bt="([^"]+)"/.exec(cellXml)?.[1];
  if (type === "inlineStr") {
    return xmlDecode(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cellXml)?.[1] || "");
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] || "";
  if (type === "s") return sharedStrings[Number(raw)] || "";
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return xmlDecode(raw);
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowMatches = xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g);
  for (const rowMatch of rowMatches) {
    const row = [];
    const cellMatches = rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g);
    for (const cellMatch of cellMatches) {
      const ref = /\br="([^"]+)"/.exec(cellMatch[1])?.[1] || "";
      const index = columnIndex(ref);
      row[index < 0 ? row.length : index] = readCellValue(`<c ${cellMatch[1]}>${cellMatch[2]}</c>`, sharedStrings);
    }
    if (row.some((value) => value != null && String(value).trim() !== "")) rows.push(row.map((value) => value ?? ""));
  }
  return rows;
}

export function parseXlsx(buffer) {
  const files = unzipEntries(buffer);
  const sharedStrings = readSharedStrings(files.get("xl/sharedStrings.xml"));
  const sheetName = [...files.keys()].find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetName) throw new InputError("XLSX file did not contain a worksheet");
  return parseSheet(files.get(sheetName), sharedStrings);
}
