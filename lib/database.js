const mongoose = require('mongoose');
mongoose.set('strictQuery', false);
const config = require('../config');

const sessionSchema = new mongoose.Schema({ number: String, creds: Object });
const Session = mongoose.model('Session', sessionSchema);
const numberSchema = new mongoose.Schema({ number: String });
const NumberModel = mongoose.model('Number', numberSchema);

module.exports = {
    connectdb: async () => await mongoose.connect(config.MONGODB_URI),
    saveSessionToMongoDB: async (number, creds) => await Session.findOneAndUpdate({ number }, { creds }, { upsert: true }),
    getSessionFromMongoDB: async (number) => (await Session.findOne({ number }))?.creds || null,
    deleteSessionFromMongoDB: async (number) => { await Session.deleteOne({ number }); await NumberModel.deleteOne({ number }); },
    addNumberToMongoDB: async (number) => await NumberModel.findOneAndUpdate({ number }, { number }, { upsert: true }),
    removeNumberFromMongoDB: async (number) => await NumberModel.deleteOne({ number }),
    getAllNumbersFromMongoDB: async () => (await NumberModel.find()).map(n => n.number)
};