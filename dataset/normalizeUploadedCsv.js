function cleanCell(value) {
  return `${value ?? ''}`.replace(/\s+/g, ' ').trim();
}

function splitCsvLine(line) {
  return line.split(';').map(cleanCell);
}

function looksLikeAddressLine(value) {
  return /\d/.test(value) || /\b(st|street|ave|avenue|road|rd|lane|ln|blvd|drive|dr|suite|ste|unit|po box|travessa|rua|avenida)\b/i.test(value);
}

function extractCityRegionPostal(parts) {
  const joined = cleanCell(parts.join(' '));
  const countryMatch = /\b(CANADA|UNITED STATES|USA|US|BRAZIL|GERMANY)\b/i.exec(joined);
  const country = countryMatch ? countryMatch[1].toUpperCase() : 'UNITED STATES';

  for (const line of parts) {
    const noCountry = cleanCell(line.replace(/\b(CANADA|UNITED STATES|USA|US|BRAZIL|GERMANY)\b/gi, ''));
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
  return [row.address1, row.address2, row.city, row.region, row.postal, row.country]
    .map(cleanCell)
    .filter(Boolean)
    .join(', ');
}

function normalizeAddressRow(columns) {
  const rawLines = columns.slice(1, 8).map(cleanCell).filter(Boolean);
  const zipSort = cleanCell(columns[8]);

  let name = '';
  const addressParts = [];

  for (let i = 0; i < rawLines.length; i += 1) {
    const value = rawLines[i];
    if (i === 0 && !looksLikeAddressLine(value)) {
      name = value;
      continue;
    }
    addressParts.push(value);
  }

  const cityRegionPostal = extractCityRegionPostal(addressParts);
  const locationLineIndex = addressParts.findIndex((line) =>
    /(.*?)[,\s]+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/.test(
      cleanCell(line.replace(/\b(CANADA|UNITED STATES|USA|US|BRAZIL|GERMANY)\b/gi, '')),
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

  if (headerIndex < 0) {
    throw new Error('CSV format not recognized: missing SHARES header.');
  }

  const dataLines = lines.slice(headerIndex + 1);
  const normalizedRows = [];

  for (const line of dataLines) {
    const columns = splitCsvLine(line);
    if (columns.length < 9) {
      continue;
    }
    if (!cleanCell(columns[0])) {
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
