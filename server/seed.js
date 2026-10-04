const Corridor = require('./models/Corridor');
const FlightPlan = require('./models/FlightPlan');
const Counter = require('./models/Counter');
const User = require('./models/User');
const Organization = require('./models/Organization');

function nigeriaDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return value('year') + '-' + value('month') + '-' + value('day');
}

const KADUNA_SEED = [
  { letter: 'A', operator: 'Nimbus Health', ncaaId: 'NCAA-RPAS-0041', from: 'Kaduna Hub', to: 'Giwa Clinic', payload: 'medical', band: '300ft', startMin: 840, endMin: 860 },
  { letter: 'B', operator: 'Rigasa Agritech', ncaaId: 'NCAA-RPAS-0058', from: 'Kaduna Hub', to: 'Rigasa Farms', payload: 'agriculture', band: '300ft', startMin: 840, endMin: 860 },
  { letter: 'C', operator: 'Nimbus Health', ncaaId: 'NCAA-RPAS-0041', from: 'Kaduna Hub', to: 'Giwa Clinic', payload: 'medical', band: '400ft', startMin: 540, endMin: 575 },
  { letter: 'D', operator: 'Terra Watch', ncaaId: 'NCAA-RPAS-0033', from: 'Zaria Hub', to: 'Sabon Gari', payload: 'security', band: '500ft', startMin: 670, endMin: 700 },
];

const CORRIDOR_SEEDS = [
  { slug: 'kaduna-northwest', label: 'Kaduna – Northwest' },
  { slug: 'zaria-central', label: 'Zaria – Central' },
  { slug: 'lagos-southwest', label: 'Lagos – Southwest' },
  { slug: 'abuja-central', label: 'Abuja – Central' },
  { slug: 'ibadan-west', label: 'Ibadan – West' },
  { slug: 'kano-north', label: 'Kano – North' },
  { slug: 'enugu-east', label: 'Enugu – East' },
  { slug: 'port-harcourt-south-south', label: 'Port Harcourt – South South' },
  { slug: 'jos-plateau', label: 'Jos – Plateau' },
  { slug: 'owerri-southeast', label: 'Owerri – Southeast' },
  { slug: 'benin-midwest', label: 'Benin – Mid West' },
  { slug: 'warri-south-south', label: 'Warri – South South' },
];

async function ensureSeedData() {
  const standaloneUsers = await User.find({ $or: [{ organization: null }, { organization: { $exists: false } }] });
  for (const user of standaloneUsers) {
    user.organizationName = user.organizationName || user.name || 'Operator';
    const organization = await Organization.findOne({ owner: user._id })
      || await Organization.create({ name: user.organizationName || user.name, owner: user._id });
    user.organization = organization._id;
    user.role = 'owner';
    await user.save();
  }

  for (const data of CORRIDOR_SEEDS) {
    await Corridor.updateOne({ slug: data.slug }, { $setOnInsert: data }, { upsert: true });
  }

  const kaduna = await Corridor.findOne({ slug: 'kaduna-northwest' });
  const today = nigeriaDateString();
  const flightCount = await FlightPlan.countDocuments({ corridor: kaduna._id });
  if (flightCount === 0) {
    await FlightPlan.insertMany(KADUNA_SEED.map((flight) => ({ ...flight, corridor: kaduna._id, flightDate: today, isDemo: true })));
  }
  await FlightPlan.updateMany(
    { corridor: kaduna._id, letter: { $in: KADUNA_SEED.map((flight) => flight.letter) }, owner: null },
    { $set: { isDemo: true } },
  );
  await FlightPlan.updateMany(
    { corridor: kaduna._id, isDemo: true, flightDate: { $in: ['', null] } },
    { $set: { flightDate: today } },
  );

  const highestSeedLetter = KADUNA_SEED.length;
  await Counter.updateOne(
    { _id: 'flightLetter' },
    { $max: { seq: highestSeedLetter } },
    { upsert: true },
  );
}

module.exports = { CORRIDOR_SEEDS, KADUNA_SEED, ensureSeedData };