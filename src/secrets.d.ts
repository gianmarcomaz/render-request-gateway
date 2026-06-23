// Wrangler cannot infer deployed secrets, so keep only secret names in this tiny augment.
declare namespace Cloudflare {
  interface Env {
    API_KEY_HASHES_JSON: string;
  }
}

interface Env {
  API_KEY_HASHES_JSON: string;
}
