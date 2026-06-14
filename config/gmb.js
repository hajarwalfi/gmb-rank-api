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
}

module.exports = new GMBAPI();
