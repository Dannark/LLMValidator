function cleanCell(value) {
  return `${value ?? ''}`.replace(/\s+/g, ' ').trim();
}

function splitCsvLine(line) {
  return line.split(';').map(cleanCell);
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

  const headerIndex = lines.findIndex((line) =>
    line.startsWith('SHARES;1ST LINE OF NAME & ADDRESS;'),
  );

  // Some user-edited files may not include the original header.
  const dataLines = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines;
  const normalizedRows = [];

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
