import { transaction } from '../db/index.js';

function requiredEnvironmentVariable(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

const appId = process.env.APP_ID?.trim() || 'yash-dim';
const bungieApiKey = requiredEnvironmentVariable('BUNGIE_API_KEY');
const dimApiKey = requiredEnvironmentVariable('DIM_API_KEY');
const appOrigin = new URL(requiredEnvironmentVariable('APP_ORIGIN')).origin;

await transaction(async (client) => {
  await client.query({
    text: `INSERT INTO apps (id, bungie_api_key, dim_api_key, origin)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        bungie_api_key = EXCLUDED.bungie_api_key,
        dim_api_key = EXCLUDED.dim_api_key,
        origin = EXCLUDED.origin`,
    values: [appId, bungieApiKey, dimApiKey, appOrigin],
  });
});

console.log(`Registered DIM API app "${appId}" for ${appOrigin}`);
process.exit(0);
