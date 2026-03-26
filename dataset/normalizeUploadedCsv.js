function cleanCell(value) {
  return `${value ?? ''}`.replace(/\s+/g, ' ').trim();
}

function detectDelimiter(line) {
  const raw = `${line ?? ''}`;
  let inQuotes = false;
  let commaCount = 0;
  let semicolonCount = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const next = raw[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === ',') {
      commaCount += 1;
    } else if (!inQuotes && char === ';') {
      semicolonCount += 1;
    }
  }

  return semicolonCount >= commaCount ? ';' : ',';
}

function splitCsvLine(line, delimiter) {
  const raw = `${line ?? ''}`;
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const next = raw[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      values.push(cleanCell(current));
      current = '';
      continue;
    }

    current += char;
  }

  values.push(cleanCell(current));
  return values;
}

function detectZipSortIndex(columns) {
  // Typical schema: index 8 is "ZIP CODE FOR SORTING"
  const maybeZip = cleanCell(columns[8]);
  if (/^\d{5}(?:-\d{4})?$/.test(maybeZip)) {
    return 8;
  }

  // Fallback: find a ZIP-like column near the end
  for (let i = columns.length - 1; i >= 1; i -= 1) {
    const cell = cleanCell(columns[i]);
    if (/^\d{5}(?:-\d{4})?$/.test(cell)) {
      return i;
    }
  }

  // If we can't find it, use as much as we have (skip SHARES col 0)
  return Math.max(1, columns.length - 1);
}

function buildPromptFromColumns(columns, zipSortIndex) {
  return columns
    .slice(1, zipSortIndex + 1)
    .map(cleanCell)
    .filter(Boolean)
    .join(', ');
}

function normalizeAddressRow(columns) {
  const zipSortIndex = detectZipSortIndex(columns);
  const zipSort = cleanCell(columns[zipSortIndex] || '');
  const postal = cleanCell(columns[6] || '') || zipSort;

  const name = [columns[1], columns[2], columns[3]].map(cleanCell).filter(Boolean).join(' ');
  const city = cleanCell(columns[4] || '');
  const region = cleanCell(columns[5] || '');
  const country = cleanCell(columns[7] || '');

  return {
    name,
    address1: cleanCell(columns[2] || ''),
    address2: cleanCell(columns[3] || ''),
    city,
    region,
    country,
    postal,
    zip_sort: zipSort,
  };
}

function normalizeUploadedCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const firstNonEmptyLine = lines[0] || '';
  const delimiter = detectDelimiter(firstNonEmptyLine);
  const headerIndex = lines.findIndex((line) =>
    /SHARES.*1ST LINE OF NAME & ADDRESS/i.test(line),
  );

  // Some user-edited files may not include the original header.
  const dataLines = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines;
  const normalizedRows = [];

  for (const line of dataLines) {
    const columns = splitCsvLine(line, delimiter);
    if (columns.length < 9) {
      continue;
    }
    if (!cleanCell(columns[0])) {
      continue;
    }
    if (/^descri/i.test(cleanCell(columns[columns.length - 1])) || /DESCRIÇÃO/i.test(line)) {
      continue;
    }

    const zipSortIndex = detectZipSortIndex(columns);
    const normalized = normalizeAddressRow(columns);
    const prompt = buildPromptFromColumns(columns, zipSortIndex);
    if (!prompt) {
      continue;
    }

    normalizedRows.push({
      input: prompt,
      source_original: normalized,
      meta: {
        source_type: 'uploaded_csv',
      },
    });
  }

  return normalizedRows;
}

module.exports = {
  normalizeUploadedCsv,
};
