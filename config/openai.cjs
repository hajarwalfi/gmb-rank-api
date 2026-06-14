const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

module.exports = openai;
module.exports.OPENAI_API_KEY = OPENAI_API_KEY;
