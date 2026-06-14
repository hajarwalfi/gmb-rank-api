const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');

const MONGODB_URI = (process.env.MONGODB_URI || '').trim() ||
  'mongodb+srv://terrencechungong_db_user:Chefor2004@cluster0.s1kicii.mongodb.net/?appName=Cluster0';
const MONGODB_DB_NAME = (process.env.MONGODB_DB_NAME || 'test').trim();

function getMongooseConnectOptions(extra = {}) {
  return { dbName: MONGODB_DB_NAME, serverSelectionTimeoutMS: 20000, maxIdleTimeMS: 120000, ...extra };
}

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGODB_URI, getMongooseConnectOptions());
    console.log(`MongoDB Connected: ${conn.connection.host} db: ${conn.connection.name}`);
  } catch (error) {
    console.error(`⚠️ MongoDB Connection Error: ${error.message}`);
  }
};

module.exports = connectDB;
module.exports.MONGODB_URI = MONGODB_URI;
module.exports.MONGODB_DB_NAME = MONGODB_DB_NAME;
module.exports.getMongooseConnectOptions = getMongooseConnectOptions;
