const { google } = require('googleapis');
const axios = require('axios');

class GMBAPI {
  constructor() {
    this.baseURL = 'https://mybusiness.googleapis.com/v4';
    this.CLIENT_ID = process.env.GMB_CLIENT_ID || '';
    this.CLIENT_SECRET = process.env.GMB_CLIENT_SECRET || '';
    this.REDIRECT_URI = process.env.GMB_REDIRECT_URI || '';
    this.REFRESH_TOKEN = process.env.GMB_REFRESH_TOKEN || '';

    this.oauth2Client = new google.auth.OAuth2(this.CLIENT_ID, this.CLIENT_SECRET, this.REDIRECT_URI);
    if (this.REFRESH_TOKEN) {
      this.oauth2Client.setCredentials({ refresh_token: this.REFRESH_TOKEN });
    }
  }

  async getAccessToken() {
    const { token } = await this.oauth2Client.getAccessToken();
    return token;
  }

  async getHeaders() {
    const token = await this.getAccessToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async listAccounts() {
    const headers = await this.getHeaders();
    const url = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
    let allAccounts = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ pageSize: '20' });
      if (pageToken) params.append('pageToken', pageToken);
      const response = await axios.get(`${url}?${params}`, { headers });
      const accounts = response.data?.accounts || [];
      allAccounts.push(...accounts);
      pageToken = response.data?.nextPageToken || null;
    } while (pageToken);
    return allAccounts.map(a => ({
      accountId: a.name,
      accountIdShort: a.name?.split('/').pop(),
      accountName: a.accountName || a.name,
      type: a.type,
      verificationState: a.verificationState,
    }));
  }

  async listLocations(accountId) {
    const headers = await this.getHeaders();
    const accountName = accountId.startsWith('accounts/') ? accountId : `accounts/${accountId}`;
    const baseURL = 'https://mybusinessbusinessinformation.googleapis.com/v1';
    const readMask = 'name,title,storeCode,websiteUri,storefrontAddress';
    let allLocations = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ readMask, pageSize: '100' });
      if (pageToken) params.append('pageToken', pageToken);
      const response = await axios.get(`${baseURL}/${accountName}/locations?${params}`, { headers });
      allLocations.push(...(response.data?.locations || []));
      pageToken = response.data?.nextPageToken || null;
    } while (pageToken);
    return allLocations.map(loc => ({
      locationId: loc.name,
      locationIdShort: loc.name?.split('/').pop(),
      name: loc.title || 'Unnamed',
      storeCode: loc.storeCode || null,
      address: loc.storefrontAddress || null,
      websiteUrl: loc.websiteUri || null,
    }));
  }
}

module.exports = new GMBAPI();
