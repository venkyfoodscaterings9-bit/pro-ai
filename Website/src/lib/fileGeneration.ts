import type { GeneratedFile } from "../types";
import { getSheetsFromFile, parseSheets, parseSlides, sanitizeHtmlPreview, type OutputSheet } from "./smartOutput";

const MIME_TYPES: Record<GeneratedFile["format"], string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv;charset=utf-8",
  html: "text/html;charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  markdown: "text/markdown;charset=utf-8",
  json: "application/json;charset=utf-8",
  txt: "text/plain;charset=utf-8",
  chart: "image/png",
};

const encoder = new TextEncoder();

function xmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character] ?? character);
}

function colName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

async function toSheetXml(sheet: OutputSheet): Promise<string> {
  const rows = [sheet.columns, ...sheet.rows];
  const maxColumns = Math.max(1, ...rows.map((row) => row.length));
  const widths = Array.from({ length: maxColumns }, (_, column) => Math.min(42, Math.max(12,
    ...rows.slice(0, 100).map((row) => String(row[column] ?? "").length + 2),
  )));
  const rowXml: string[] = [];
  for (let offset = 0; offset < rows.length; offset += 500) {
    rowXml.push(...rows.slice(offset, offset + 500).map((row, rowOffset) => {
      const rowIndex = offset + rowOffset;
      const cells = row.map((value, columnIndex) => {
        const ref = `${colName(columnIndex)}${rowIndex + 1}`;
        const header = String(sheet.columns[columnIndex] ?? "").toLowerCase();
        const styleId = rowIndex === 0 ? 1
          : typeof value === "number" && Number.isFinite(value)
            ? /(amount|price|cost|total|balance|revenue|salary)/.test(header) ? 2
              : /percent|percentage/.test(header) ? 3 : rowIndex % 2 === 0 ? 5 : 0
            : /date|day/.test(header) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? 4
              : rowIndex % 2 === 0 ? 5 : 0;
        const style = styleId ? ` s="${styleId}"` : "";
        if (typeof value === "number" && Number.isFinite(value)) {
          return `<c r="${ref}"${style}><v>${value}</v></c>`;
        }
        if (typeof value === "boolean") return `<c r="${ref}" t="b"${style}><v>${value ? 1 : 0}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }).join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }));
    if (offset + 500 < rows.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const lastColumn = colName(Math.max(0, maxColumns - 1));
  const lastRow = Math.max(1, rows.length);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${rowXml.join("")}</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/></worksheet>`;
}

type ZipEntry = { name: string; content: string | Uint8Array };

function write16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function write32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true); }

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries: ZipEntry[], mimeType: string): Blob {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const content = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const crc = crc32(content);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0x0800);
    write16(localView, 8, 0);
    write32(localView, 14, crc);
    write32(localView, 18, content.length);
    write32(localView, 22, content.length);
    write16(localView, 26, name.length);
    local.set(name, 30);
    localParts.push(local, content);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 20);
    write16(centralView, 6, 20);
    write16(centralView, 8, 0x0800);
    write16(centralView, 10, 0);
    write32(centralView, 16, crc);
    write32(centralView, 20, content.length);
    write32(centralView, 24, content.length);
    write16(centralView, 28, name.length);
    write32(centralView, 42, offset);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + content.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 8, entries.length);
  write16(endView, 10, entries.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, offset);
  return new Blob([...localParts, ...centralParts, end], { type: mimeType });
}

async function spreadsheetBlob(file: GeneratedFile): Promise<Blob> {
  const sheets = getSheetsFromFile(file);
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xmlEscape(sheet.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;[Red](#,##0.00)"/><numFmt numFmtId="165" formatCode="0.00%"/></numFmts><fonts count="3"><font><sz val="11"/><color rgb="FF27243A"/><name val="Aptos"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font><font><b/><sz val="15"/><color rgb="FF5947C8"/><name val="Aptos Display"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF6958D8"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF5F3FC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFE5E2F0"/></left><right style="thin"><color rgb="FFE5E2F0"/></right><top style="thin"><color rgb="FFE5E2F0"/></top><bottom style="thin"><color rgb="FFE5E2F0"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>` },
    ...await Promise.all(sheets.map(async (sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: await toSheetXml(sheet) }))),
  ];
  return zipStore(entries, MIME_TYPES.xlsx);
}

async function csvText(file: GeneratedFile): Promise<string> {
  const sheets = getSheetsFromFile(file);
  const sheet = sheets[0] ?? { name: "Sheet1", columns: [], rows: [] };
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows: string[] = [sheet.columns.map(escape).join(",")];
  for (let offset = 0; offset < sheet.rows.length; offset += 500) {
    rows.push(...sheet.rows.slice(offset, offset + 500).map((row) => row.map(escape).join(",")));
    if (offset + 500 < sheet.rows.length) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  return `\ufeff${rows.join("\r\n")}`;
}

function docxBlob(file: GeneratedFile): Blob {
  const lines = file.content.split(/\r?\n/);
  const body: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith("|") && index + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[index + 1].trim())) {
      const tableLines = [line];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) tableLines.push(lines[index++].trim());
      index -= 1;
      const tableRows = tableLines.map((tableLine) => tableLine.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
      body.push(`<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8B8C8"/><w:left w:val="single" w:sz="4" w:color="B8B8C8"/><w:bottom w:val="single" w:sz="4" w:color="B8B8C8"/><w:right w:val="single" w:sz="4" w:color="B8B8C8"/><w:insideH w:val="single" w:sz="4" w:color="B8B8C8"/><w:insideV w:val="single" w:sz="4" w:color="B8B8C8"/></w:tblBorders></w:tblPr>${tableRows.map((row, rowIndex) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr/><w:p><w:r>${rowIndex === 0 ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xmlEscape(cell)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`);
      continue;
    }
    const heading = /^#{1,6}\s/.test(line);
    const text = xmlEscape(line.replace(/^#{1,6}\s*/, "").replace(/^\s*[-*+]\s+/, "• "));
    body.push(`<w:p><w:r>${heading ? "<w:rPr><w:b/><w:sz w:val=\"30\"/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`);
  }
  return zipStore([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>` },
  ], MIME_TYPES.docx);
}

function pptxBlob(file: GeneratedFile): Blob {
  const slides = parseSlides(file.content);
  const slideContent = (title: string, bullets: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="762000" y="508000"/><a:ext cx="10668000" cy="1300000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2800" b="1"/><a:t>${xmlEscape(title)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="762000" y="2100000"/><a:ext cx="10668000" cy="4800000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${bullets}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>` },
    { name: "ppt/presentation.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${slides.length + 1}"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` },
    { name: "ppt/_rels/presentation.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}<Relationship Id="rId${slides.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>` },
    { name: "ppt/slideMasters/slideMaster1.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="4F81BD" accent2="C0504D" accent3="9BBB59" accent4="8064A2" accent5="4BACC6" accent6="F79646" bg1="lt1" bg2="lt2" tx1="dk1" tx2="dk2" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>` },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>` },
    { name: "ppt/slideLayouts/slideLayout1.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>` },
    { name: "ppt/theme/theme1.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Morrow"><a:themeElements><a:clrScheme name="Morrow"><a:dk1><a:srgbClr val="222222"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="444444"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="6F5AE8"/></a:accent1><a:accent2><a:srgbClr val="56A58A"/></a:accent2><a:accent3><a:srgbClr val="D28B67"/></a:accent3><a:accent4><a:srgbClr val="6886C6"/></a:accent4><a:accent5><a:srgbClr val="8976BD"/></a:accent5><a:accent6><a:srgbClr val="E58B50"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Morrow"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme><a:fmtScheme name="Morrow"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>` },
    ...slides.map((slide, index) => ({
      name: `ppt/slides/slide${index + 1}.xml`,
      content: slideContent(slide.title, [
        ...slide.bullets.map((bullet) => `<a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US" sz="1800"/><a:t>${xmlEscape(bullet)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>`),
        ...(slide.notes ? [`<a:p><a:r><a:rPr lang="en-US" sz="1200" i="1"/><a:t>Notes: ${xmlEscape(slide.notes)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>`] : []),
      ].join("")),
    })),
    ...slides.map((_, index) => ({
      name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    })),
  ];
  return zipStore(entries, MIME_TYPES.pptx);
}

function pdfBlob(markdown: string): Blob {
  const normalize = (value: string) => value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e]/g, "?");
  const escapePdf = (value: string) => normalize(value).replace(/[\\()]/g, "\\$&");
  const pages: string[][] = [[]];
  let page = pages[0];
  let y = 786;
  const left = 54;
  const right = 558;
  const usableWidth = right - left;
  const pageBreak = () => {
    page = [];
    pages.push(page);
    y = 786;
  };
  const ensureSpace = (height: number) => {
    if (y - height < 55) pageBreak();
  };
  const drawText = (text: string, x: number, baseline: number, size: number, color: string, font = "F1") => {
    const [red, green, blue] = color.split(" ").map(Number);
    page.push(`BT /${font} ${size} Tf ${red} ${green} ${blue} rg 1 0 0 1 ${x.toFixed(1)} ${baseline.toFixed(1)} Tm (${escapePdf(text)}) Tj ET`);
  };
  const fillRect = (x: number, baseline: number, width: number, height: number, color: string) => {
    const [red, green, blue] = color.split(" ").map(Number);
    page.push(`${red} ${green} ${blue} rg ${x.toFixed(1)} ${baseline.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)} re f`);
  };
  const wrap = (text: string, maxCharacters: number): string[] => {
    const words = normalize(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (word.length > maxCharacters) {
        if (line) lines.push(line);
        line = "";
        for (let offset = 0; offset < word.length; offset += maxCharacters) {
          const part = word.slice(offset, offset + maxCharacters);
          if (offset + maxCharacters < word.length) lines.push(part);
          else line = part;
        }
      } else if (line && line.length + word.length + 1 > maxCharacters) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  };
  const drawParagraph = (text: string, options: { size?: number; color?: string; indent?: number; bold?: boolean; gap?: number } = {}) => {
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    const maxCharacters = Math.max(20, Math.floor((usableWidth - indent) / (size * 0.53)));
    const lines = text.split(/\r?\n/).flatMap((line) => wrap(line, maxCharacters));
    const lineHeight = size * 1.55;
    ensureSpace(lines.length * lineHeight + (options.gap ?? 8));
    lines.forEach((line) => {
      drawText(line, left + indent, y, size, options.color ?? "0.16 0.15 0.22", options.bold ? "F2" : "F1");
      y -= lineHeight;
    });
    y -= options.gap ?? 8;
  };
  const drawTable = (tableRows: string[][]) => {
    const columnCount = Math.max(1, ...tableRows.map((row) => row.length));
    const colWidth = usableWidth / columnCount;
    const charLimit = Math.max(8, Math.floor((colWidth - 14) / 5.2));
    const rowData = tableRows.map((row) => Array.from({ length: columnCount }, (_, index) =>
      wrap(row[index] ?? "", charLimit),
    ));
    rowData.forEach((cells, rowIndex) => {
      const rowHeight = Math.max(24, Math.max(...cells.map((cell) => cell.length)) * 12 + 10);
      ensureSpace(rowHeight + 1);
      if (rowIndex === 0) fillRect(left, y - rowHeight + 5, usableWidth, rowHeight, "0.91 0.89 0.97");
      else if (rowIndex % 2 === 0) fillRect(left, y - rowHeight + 5, usableWidth, rowHeight, "0.97 0.97 0.99");
      cells.forEach((lines, columnIndex) => {
        lines.forEach((line, lineIndex) => drawText(
          line,
          left + columnIndex * colWidth + 7,
          y - 10 - lineIndex * 12,
          rowIndex === 0 ? 8.5 : 8,
          rowIndex === 0 ? "0.28 0.24 0.47" : "0.2 0.19 0.25",
          rowIndex === 0 ? "F2" : "F1",
        ));
        const x = left + columnIndex * colWidth;
        page.push(`0.82 0.81 0.87 RG 0.45 w ${x.toFixed(1)} ${(y - rowHeight + 5).toFixed(1)} m ${x.toFixed(1)} ${(y + 5).toFixed(1)} l S`);
      });
      page.push(`0.82 0.81 0.87 RG 0.45 w ${left} ${(y - rowHeight + 5).toFixed(1)} m ${right} ${(y - rowHeight + 5).toFixed(1)} l S`);
      y -= rowHeight;
    });
    y -= 13;
  };
  page.push("0.42 0.35 0.84 rg 0 826 612 16 re f");
  drawText("MORROW  /  GENERATED DOCUMENT", left, 804, 8, "0.35 0.32 0.51", "F2");
  y = 772;
  const blocks = markdown.split(/\r?\n/);
  let firstHeading = true;
  for (let index = 0; index < blocks.length; index += 1) {
    const line = blocks[index].trim();
    if (!line || /^[-*_]{3,}$/.test(line)) continue;
    if (line.startsWith("|") && index + 1 < blocks.length && /^\|?\s*:?-{3,}/.test(blocks[index + 1].trim())) {
      const tableRows = [line];
      index += 2;
      while (index < blocks.length && blocks[index].trim().startsWith("|")) tableRows.push(blocks[index++].trim());
      index -= 1;
      drawTable(tableRows.map((row) => row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim())));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].replace(/\*\*/g, "").replace(/\*/g, "");
      if (firstHeading) {
        const headingLines = wrap(title, 54);
        ensureSpace(headingLines.length * 29 + 10);
        headingLines.forEach((headingLine) => {
          drawText(headingLine, left, y, 22, "0.16 0.15 0.25", "F2");
          y -= 29;
        });
        page.push(`0.42 0.35 0.84 RG 1.5 w ${left} ${y + 8} m ${left + 64} ${y + 8} l S`);
        y -= 16;
        firstHeading = false;
      } else {
        ensureSpace(level <= 2 ? 42 : 30);
        y -= 7;
        drawParagraph(title, {
          size: level <= 2 ? 15 : level === 3 ? 12 : 10,
          color: "0.28 0.24 0.47",
          bold: true,
          gap: 7,
        });
      }
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      drawParagraph(`•  ${line.replace(/^\s*[-*+]\s+/, "").replace(/\*\*/g, "")}`, { indent: 12, gap: 3 });
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      drawParagraph(line.replace(/\*\*/g, ""), { indent: 12, gap: 3 });
    } else {
      drawParagraph(line.replace(/\*\*/g, "").replace(/\*/g, "").replace(/`([^`]+)`/g, "$1"), { gap: 7 });
    }
  }
  pages.forEach((pageContent, index) => {
    pageContent.push("0.82 0.81 0.87 RG 0.5 w 54 43 m 558 43 l S");
    drawText("Generated with Morrow", 54, 28, 8, "0.42 0.41 0.49");
    const pageNumber = `PAGE ${index + 1} OF ${pages.length}`;
    drawText(pageNumber, right - pageNumber.length * 5, 28, 8, "0.42 0.41 0.49");
  });
  const objects: string[] = [];
  const firstPageId = 3;
  const fontRegularId = firstPageId + pages.length * 2;
  const fontBoldId = fontRegularId + 1;
  const pageRefs = pages.map((_, index) => `${firstPageId + index * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
  pages.forEach((pageContent, index) => {
    const pageId = firstPageId + index * 2;
    const streamId = pageId + 1;
    const content = pageContent.join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${streamId} 0 R >>`);
    objects.push(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  let documentText = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(documentText).length);
    documentText += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = encoder.encode(documentText).length;
  documentText += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  documentText += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  documentText += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([documentText], { type: MIME_TYPES.pdf });
}

export function chartDataUri(file: GeneratedFile): string {
  const sheets = getSheetsFromFile(file);
  const sheet = sheets[0] ?? { name: "Chart", columns: [], rows: [] };
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 600;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not render a chart preview.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#262535";
  context.font = "bold 24px sans-serif";
  context.fillText(sheet.name || "Chart", 55, 48);
  const numericColumn = sheet.columns.findIndex((column) => sheet.rows.some((row) => typeof row[sheet.columns.indexOf(column)] === "number"));
  const valueIndex = numericColumn >= 0 ? numericColumn : 1;
  const labelIndex = Math.max(0, sheet.columns.findIndex((_, index) => index !== valueIndex));
  const points = sheet.rows.filter((row) => Number.isFinite(Number(row[valueIndex]))).slice(0, 100);
  const maximum = Math.max(1, ...points.map((row) => Number(row[valueIndex])));
  const chartTop = 90;
  const chartHeight = 430;
  const barWidth = Math.max(2, Math.min(34, 820 / Math.max(points.length, 1) - 6));
  context.strokeStyle = "#d9d9e3";
  context.beginPath();
  context.moveTo(80, chartTop);
  context.lineTo(80, chartTop + chartHeight);
  context.lineTo(940, chartTop + chartHeight);
  context.stroke();
  points.forEach((row, index) => {
    const value = Number(row[valueIndex]);
    const height = Math.max(2, value / maximum * chartHeight);
    const x = 95 + index * (820 / Math.max(points.length, 1));
    context.fillStyle = "#7661e8";
    context.fillRect(x, chartTop + chartHeight - height, barWidth, height);
    if (points.length <= 30) {
      context.save();
      context.translate(x + barWidth / 2, chartTop + chartHeight + 10);
      context.rotate(-Math.PI / 4);
      context.fillStyle = "#575667";
      context.font = "11px sans-serif";
      context.fillText(String(row[labelIndex] ?? ""), 0, 0);
      context.restore();
    }
  });
  return canvas.toDataURL("image/png");
}

export async function buildFileBlob(file: GeneratedFile): Promise<Blob> {
  switch (file.format) {
    case "xlsx": return spreadsheetBlob(file);
    case "csv": return new Blob([await csvText(file)], { type: MIME_TYPES.csv });
    case "html": return new Blob([file.content], { type: MIME_TYPES.html });
    case "pdf": return pdfBlob(file.content);
    case "docx": return docxBlob(file);
    case "pptx": return pptxBlob(file);
    case "chart": {
      const image = file.content.startsWith("data:image/png,")
        ? file.content
        : chartDataUri(file);
      const response = await fetch(image);
      return response.blob();
    }
    case "markdown": return new Blob([file.content], { type: MIME_TYPES.markdown });
    case "json": return new Blob([file.content], { type: MIME_TYPES.json });
    case "txt": return new Blob([file.content], { type: MIME_TYPES.txt });
  }
}

export function previewHtml(file: GeneratedFile): string {
  return sanitizeHtmlPreview(file.content);
}

export function fileByteSize(file: GeneratedFile): number {
  if (file.format === "chart") {
    const image = file.content.startsWith("data:image/png,") ? file.content : chartDataUri(file);
    return Math.max(0, Math.floor((image.length - 22) * 3 / 4));
  }
  return encoder.encode(file.content).length;
}

export function sourceSheets(content: string): OutputSheet[] {
  return parseSheets(content);
}
