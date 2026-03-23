const fs = require('fs/promises');
const path = require('path');
const { faker, fakerPT_BR, fakerEN_US, fakerDE } = require('@faker-js/faker');

const DEFAULT_TOTAL_ENTRIES = 60;
const OUTPUT_FILE = path.join(__dirname, 'addresses.dataset.json');
const SUPPORTED_LOCALES = ['mixed', 'en_US', 'pt_BR', 'de_DE'];

const COUNTRY_CONFIGS = [
  {
    label: 'US',
    localeCode: 'en_US',
    fakerInstance: fakerEN_US,
    countryName: 'United States',
    postalCode: () => fakerEN_US.location.zipCode('#####'),
    state: () => fakerEN_US.location.state(),
    rawFormatter: ({ street, city, state, postalCode, country }) =>
      `${street}, ${city}, ${state}, ${postalCode}, ${country}`,
  },
  {
    label: 'BR',
    localeCode: 'pt_BR',
    fakerInstance: fakerPT_BR,
    countryName: 'Brazil',
    postalCode: () => fakerPT_BR.location.zipCode('#####-###'),
    state: () => fakerPT_BR.location.state({ abbreviated: true }),
    rawFormatter: ({ street, city, state, postalCode, country }) =>
      `${street}, ${city} - ${state}, ${postalCode}, ${country}`,
  },
  {
    label: 'EU',
    localeCode: 'de_DE',
    fakerInstance: fakerDE,
    countryName: 'Germany',
    postalCode: () => fakerDE.location.zipCode('#####'),
    state: () => fakerDE.location.state(),
    rawFormatter: ({ street, city, state, postalCode, country }) =>
      `${street}, ${postalCode} ${city}, ${state}, ${country}`,
  },
];

function pickCountryConfig(index, locale = 'mixed') {
  if (locale === 'mixed') {
    return COUNTRY_CONFIGS[index % COUNTRY_CONFIGS.length];
  }

  const filtered = COUNTRY_CONFIGS.filter((config) => config.localeCode === locale);
  if (filtered.length === 0) {
    throw new Error(`Locale inválido: ${locale}`);
  }
  return filtered[index % filtered.length];
}

function generateCleanAddress(config) {
  const f = config.fakerInstance;
  const expected = {
    street: f.location.streetAddress(),
    city: f.location.city(),
    state: config.state(),
    postal_code: config.postalCode(),
    country: config.countryName,
  };

  const input = config.rawFormatter({
    street: expected.street,
    city: expected.city,
    state: expected.state,
    postalCode: expected.postal_code,
    country: expected.country,
  });

  return { input, expected };
}

function shuffleArray(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = faker.number.int({ min: 0, max: i });
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function abbreviateStreet(street) {
  return street
    .replace(/\bStreet\b/gi, 'St')
    .replace(/\bAvenue\b/gi, 'Ave')
    .replace(/\bRoad\b/gi, 'Rd')
    .replace(/\bRua\b/gi, 'R.')
    .replace(/\bAvenida\b/gi, 'Av.')
    .replace(/\bStrasse\b/gi, 'Str.');
}

function generateMessyAddress(entry) {
  const tokens = [
    abbreviateStreet(entry.expected.street),
    entry.expected.city,
    entry.expected.state,
    entry.expected.postal_code,
    entry.expected.country,
  ];

  const shuffled = shuffleArray(tokens);
  const separators = [' ', ' - ', ' / '];
  const separator = faker.helpers.arrayElement(separators);
  const asSingleLine = shuffled.join(separator);

  return asSingleLine
    .replace(/,/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildDataset(totalEntries = DEFAULT_TOTAL_ENTRIES, locale = 'mixed') {
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw new Error(`Locale não suportado. Opções: ${SUPPORTED_LOCALES.join(', ')}`);
  }

  const dataset = [];

  for (let i = 0; i < totalEntries; i += 1) {
    const countryConfig = pickCountryConfig(i, locale);
    const cleanEntry = generateCleanAddress(countryConfig);
    const messyInput = generateMessyAddress(cleanEntry);

    dataset.push({
      input: messyInput,
      expected: cleanEntry.expected,
      meta: {
        source_country_group: countryConfig.label,
        locale: countryConfig.localeCode,
        is_messy: true,
      },
    });
  }

  return dataset;
}

async function saveDataset(dataset, outputFile = OUTPUT_FILE) {
  const payload = JSON.stringify(dataset, null, 2);
  await fs.writeFile(outputFile, payload, 'utf8');
  return outputFile;
}

async function main() {
  try {
    const dataset = buildDataset(DEFAULT_TOTAL_ENTRIES, 'mixed');
    const outputFile = await saveDataset(dataset);
    console.log(`Dataset gerado com ${dataset.length} entradas em: ${outputFile}`);
  } catch (error) {
    console.error('Falha ao gerar dataset:', error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SUPPORTED_LOCALES,
  buildDataset,
  generateMessyAddress,
  generateCleanAddress,
};
