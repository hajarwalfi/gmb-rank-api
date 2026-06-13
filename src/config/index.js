/**
 * Application config.
 * GMB and other keys are loaded from parent repo .env (see server.js dotenv order).
 * config/gmb.js is required in gmb.service.js and uses the same process.env (GMB_*).
 */
export const config = {
  get port() { return parseInt(process.env.PORT || '5524', 10); },
  get serpApiKey() { return (process.env.SERPAPI_API_KEY || '').trim(); },
  gmb: {
    get clientId() { return process.env.GMB_CLIENT_ID || ''; },
    get clientSecret() { return process.env.GMB_CLIENT_SECRET || ''; },
    get redirectUri() { return process.env.GMB_REDIRECT_URI || ''; },
    get refreshToken() { return process.env.GMB_REFRESH_TOKEN || ''; }
  },
};

export default config;
