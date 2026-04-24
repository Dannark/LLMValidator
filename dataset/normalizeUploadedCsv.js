function cleanCell(value) {
  return `${value ?? ''}`.replace(/\s+/g, ' ').trim();
}

function splitCsvLine(line) {
  return line.split(';').map(cleanCell);
}

/** Novo formato: input do modelo = colunas de planilha 5–12 (índices 0-based 4–11); Name…Country esperado em 20–25. */
const VALIDATOR_V2_INPUT_SLICE_START = 4;
const VALIDATOR_V2_INPUT_SLICE_END = 12;
const VALIDATOR_V2_MIN_COLS = 26;
const VALIDATOR_V2_GT_NAME_IDX = 20;

function isValidatorV2HeaderLine(line) {
  return /<\s*--\s*>/.test(line) && /name/i.test(line) && /address1/i.test(line);
}

function looksLikeValidatorV2DataRow(columns) {
  return columns.length >= VALIDATOR_V2_MIN_COLS;
}

function extractValidatorV2Expected(columns) {
  return {
    name: cleanCell(columns[VALIDATOR_V2_GT_NAME_IDX]),
    address1: cleanCell(columns[VALIDATOR_V2_GT_NAME_IDX + 1]),
    address2: cleanCell(columns[VALIDATOR_V2_GT_NAME_IDX + 2]),
    city: cleanCell(columns[VALIDATOR_V2_GT_NAME_IDX + 3]),
    region: cleanCell(columns[VALIDATOR_V2_GT_NAME_IDX + 4]),
    country: cleanCell(columns[VALIDATOR_V2_GT_NAME_IDX + 5]),
    zip: '',
  };
}

function buildValidatorV2InputFromRow(columns) {
  const slice = columns.slice(
    VALIDATOR_V2_INPUT_SLICE_START,
    VALIDATOR_V2_INPUT_SLICE_END,
  );
  return slice.map(cleanCell).filter(Boolean).join(', ');
}

function resolveCsvDataLines(lines) {
  if (lines.length === 0) {
    return { kind: 'empty', dataLines: [] };
  }
  if (isValidatorV2HeaderLine(lines[0])) {
    return { kind: 'validator_v2', dataLines: lines.slice(1) };
  }
  const legacyHeaderIndex = lines.findIndex((line) =>
    line.startsWith('SHARES;1ST LINE OF NAME & ADDRESS;'),
  );
  if (legacyHeaderIndex >= 0) {
    return { kind: 'legacy', dataLines: lines.slice(legacyHeaderIndex + 1) };
  }
  const firstCols = splitCsvLine(lines[0]);
  if (looksLikeValidatorV2DataRow(firstCols)) {
    return { kind: 'validator_v2', dataLines: lines };
  }
  return { kind: 'legacy', dataLines: lines };
}

function looksLikeAddressLine(value) {
  return /\d/.test(value) || /\b(st|street|ave|avenue|road|rd|lane|ln|blvd|drive|dr|suite|ste|unit|po box|travessa|rua|avenida)\b/i.test(value);
}

function looksLikeUsCityStateZip(value) {
  const cleaned = cleanCell(value);
  return /(.*?)[,\s]+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/.test(cleaned);
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

function extractCityRegionPostal(parts) {
  const joined = cleanCell(parts.join(' '));
  const countryMatch = /\b(UNITED STATES|USA|US|CANADA|BRAZIL|BR|GERMANY|DE|ISRAEL|AUSTRALIA|UNITED ARAB EMIRATES|UAE|GUATEMALA)\b/i.exec(
    joined,
  );
  const rawCountry = countryMatch ? countryMatch[1].toUpperCase() : '';
  const country =
    rawCountry === 'USA' || rawCountry === 'US'
      ? 'UNITED STATES'
      : rawCountry === 'BR'
        ? 'BRAZIL'
        : rawCountry === 'DE'
          ? 'GERMANY'
          : rawCountry === 'UAE'
            ? 'UNITED ARAB EMIRATES'
            : rawCountry || '';

  for (const line of parts) {
    const noCountry = cleanCell(
      line.replace(
        /\b(UNITED STATES|USA|US|CANADA|BRAZIL|BR|GERMANY|DE|ISRAEL|AUSTRALIA|UNITED ARAB EMIRATES|UAE|GUATEMALA)\b/gi,
        '',
      ),
    );
    const match = /(.*?)[,\s]+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/.exec(noCountry);
    if (match) {
      return {
        city: cleanCell(match[1]),
        region: cleanCell(match[2]),
        postal: cleanCell(match[3]),
        country,
      };
    }
  }

  return { city: '', region: '', postal: '', country };
}

function buildPromptFromNormalized(row) {
  // We intentionally include name lines + address lines (as in the original CSV range)
  // because sometimes the name spans multiple columns and address starts later.
  return [row.name, row.address1, row.address2, row.city, row.region, row.postal, row.country]
    .map(cleanCell)
    .filter(Boolean)
    .join(', ');
}

function normalizeAddressRow(columns) {
  const zipSortIndex = detectZipSortIndex(columns);
  const rawLines = columns
    .slice(1, zipSortIndex + 1)
    .map(cleanCell)
    .filter(Boolean);
  const zipSort = cleanCell(columns[zipSortIndex]);

  const nameLines = [];
  const addressParts = [];
  let startedAddress = false;

  for (const value of rawLines) {
    if (!startedAddress) {
      const isAddressish =
        looksLikeAddressLine(value) ||
        looksLikeUsCityStateZip(value) ||
        /\b(UNITED STATES|USA|US|CANADA|BRAZIL|BR|GERMANY|DE|ISRAEL|AUSTRALIA|UNITED ARAB EMIRATES|UAE|GUATEMALA)\b/i.test(
          value,
        );
      if (!isAddressish) {
        nameLines.push(value);
        continue;
      }
      startedAddress = true;
    }
    addressParts.push(value);
  }

  const name = nameLines.join(' ').trim();

  const cityRegionPostal = extractCityRegionPostal(addressParts);
  const locationLineIndex = addressParts.findIndex((line) =>
    /(.*?)[,\s]+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/.test(
      cleanCell(
        line.replace(
          /\b(UNITED STATES|USA|US|CANADA|BRAZIL|BR|GERMANY|DE|ISRAEL|AUSTRALIA|UNITED ARAB EMIRATES|UAE|GUATEMALA)\b/gi,
          '',
        ),
      ),
    ),
  );

  const streetLines = addressParts.filter((_line, index) => index !== locationLineIndex);
  const address1 = streetLines[0] || '';
  const address2 = streetLines.slice(1).join(', ');

  return {
    name,
    address1,
    address2,
    city: cityRegionPostal.city,
    region: cityRegionPostal.region,
    country: cityRegionPostal.country,
    postal: cityRegionPostal.postal || zipSort,
  };
}

function normalizeUploadedCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const { kind, dataLines } = resolveCsvDataLines(lines);
  const normalizedRows = [];

  if (kind === 'empty') {
    return normalizedRows;
  }

  for (const line of dataLines) {
    const columns = splitCsvLine(line);
    if (columns.length < 9) {
      continue;
    }
    if (!cleanCell(columns[0])) {
      continue;
    }
    if (/^descri/i.test(cleanCell(columns[columns.length - 1])) || /DESCRIÇÃO/i.test(line)) {
      continue;
    }

    if (kind === 'validator_v2') {
      if (!looksLikeValidatorV2DataRow(columns)) {
        continue;
      }
      const inputColumns = columns.slice(
        VALIDATOR_V2_INPUT_SLICE_START,
        VALIDATOR_V2_INPUT_SLICE_END,
      );
      const prompt = buildValidatorV2InputFromRow(columns);
      if (!prompt) {
        continue;
      }
      const expected = extractValidatorV2Expected(columns);
      normalizedRows.push({
        input: prompt,
        expected,
        source_original: {
          work_columns: inputColumns,
        },
        meta: {
          source_type: 'uploaded_csv',
          csv_format: 'validator_v2',
        },
      });
      continue;
    }

    const normalized = normalizeAddressRow(columns);
    const prompt = buildPromptFromNormalized(normalized);
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
