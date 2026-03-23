const fs = require('fs/promises');
const path = require('path');
const { faker, fakerPT_BR, fakerEN_US, fakerDE } = require('@faker-js/faker');

const DEFAULT_TOTAL_ENTRIES = 60;
const OUTPUT_FILE = path.join(__dirname, 'addresses.dataset.json');

const COUNTRY_CONFIGS = [
  {
    label: 'US',
    fakerInstance: fakerEN_US,
    countryName: 'United States',
    postalCode: () => fakerEN_US.location.zipCode('#####'),
    rawFormatter: ({ name, street, city, postalCode, country }) =>
      `${name}, ${street}, ${city}, ${postalCode}, ${country}`,
  },
  {
    label: 'BR',
    fakerInstance: fakerPT_BR,
    countryName: 'Brazil',
    postalCode: () => fakerPT_BR.location.zipCode('#####-###'),
    rawFormatter: ({ name, street, city, postalCode, country }) =>
      `${name}, ${street}, ${city} - ${postalCode}, ${country}`,
  },
  {
    label: 'EU',
    fakerInstance: fakerDE,
    countryName: 'Germany',
    postalCode: () => fakerDE.location.zipCode('#####'),
    rawFormatter: ({ name, street, city, postalCode, country }) =>
      `${name}, ${street}, ${postalCode} ${city}, ${country}`,
  },
];

function pickCountryConfig(index) {
  return COUNTRY_CONFIGS[index % COUNTRY_CONFIGS.length];
}

function generateCleanAddress(config) {
  const f = config.fakerInstance;
  const expected = {
    name: f.person.fullName(),
    street: f.location.streetAddress(),
    city: f.location.city(),
    postal_code: config.postalCode(),
    country: config.countryName,
  };

  const input = config.rawFormatter({
    name: expected.name,
    street: expected.street,
    city: expected.city,
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
    entry.expected.name,
    abbreviateStreet(entry.expected.street),
    entry.expected.city,
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

function buildDataset(totalEntries = DEFAULT_TOTAL_ENTRIES) {
  const dataset = [];

  for (let i = 0; i < totalEntries; i += 1) {
    const countryConfig = pickCountryConfig(i);
    const cleanEntry = generateCleanAddress(countryConfig);
    const messyInput = generateMessyAddress(cleanEntry);

    dataset.push({
      input: messyInput,
      expected: cleanEntry.expected,
      meta: {
        source_country_group: countryConfig.label,
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
    const dataset = buildDataset(DEFAULT_TOTAL_ENTRIES);
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
  buildDataset,
  generateMessyAddress,
  generateCleanAddress,
};
