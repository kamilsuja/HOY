'use strict';
/**
 * seed.js — initial data for the Hoy backend.
 * Mirrors the prototype's hosts, stays, and experiences.
 * Used once to create data.json; after that the file is the source of truth.
 */

function freshData() {
  const hosts = [
    { id: 'h1', name: 'Faisal A.', city: 'Mogadishu', status: 'active', evc: '61 •••• 14', evcName: 'Faisal Abdi', email: 'faisal@mail.so', phone: '+252 61 200 0014', notify: 'text' },
    { id: 'h2', name: 'Hodan M.',  city: 'Hargeisa',  status: 'active', evc: '61 •••• 72', evcName: 'Hodan Mohamed', email: 'hodan@mail.so',  phone: '+252 61 200 0072', notify: 'email' },
    { id: 'h3', name: 'Khadar Y.', city: 'Berbera',   status: 'active', evc: '61 •••• 55', evcName: 'Khadar Yusuf',  email: 'khadar@mail.so', phone: '+252 61 200 0055', notify: 'text' },
    { id: 'h4', name: 'Iqra A.',   city: 'Kismayo',   status: 'active', evc: '61 •••• 09', evcName: 'Iqra Ahmed',   email: 'iqra@mail.so',   phone: '+252 61 200 0009', notify: 'email' },
    { id: 'h5', name: 'Cabdi N.',  city: 'Bosaso',    status: 'active', evc: '61 •••• 31', evcName: 'Cabdi Nuur',   email: 'cabdi@mail.so',  phone: '+252 61 200 0031', notify: 'text' },
    { id: 'h6', name: 'Sahra D.',  city: 'Garowe',    status: 'active', evc: '61 •••• 88', evcName: 'Sahra Diiriye', email: 'sahra@mail.so', phone: '+252 61 200 0088', notify: 'email' },
  ];

  const listings = [
    { id: 'L1', hostId: 'h1', title: 'Sunlit villa steps from Lido Beach', city: 'Mogadishu', type: 'Entire villa',     price: 74, rating: 4.9, instantBook: true,  booked: [] },
    { id: 'L2', hostId: 'h2', title: 'Cosy guesthouse near the centre',     city: 'Hargeisa',  type: 'Entire guesthouse', price: 48, rating: 4.8, instantBook: false, booked: [] },
    { id: 'L3', hostId: 'h3', title: 'Beachfront guesthouse on the Gulf',   city: 'Berbera',   type: 'Entire home',      price: 60, rating: 4.7, instantBook: false, booked: [] },
    { id: 'L4', hostId: 'h4', title: 'Modern apartment near the port',      city: 'Kismayo',   type: 'Entire apartment', price: 52, rating: 5.0, instantBook: true,  booked: [] },
    { id: 'L5', hostId: 'h5', title: 'City apartment in Bosaso',            city: 'Bosaso',    type: 'Entire apartment', price: 44, rating: 4.2, instantBook: false, booked: [] },
    { id: 'L6', hostId: 'h6', title: 'Garden home in Garowe',              city: 'Garowe',    type: 'Entire home',      price: 40, rating: 4.9, instantBook: false, booked: [] },
  ];

  const experiences = [
    { id: 'E1', hostId: 'h2', title: 'Somali home cooking class', loc: 'Hargeisa',  cat: 'Food',    price: 25, rating: 4.9 },
    { id: 'E2', hostId: 'h1', title: 'Shangani old town walk',    loc: 'Mogadishu', cat: 'History', price: 18, rating: 4.8 },
    { id: 'E3', hostId: 'h3', title: 'Berbera reef snorkeling',   loc: 'Berbera',   cat: 'Nature',  price: 35, rating: 4.7 },
  ];

  // Services: each provider option is a bookable listing (kind 'service'), per-guest, paid via escrow like everything else.
  const services = [
    { id: 'SV1a', hostId: 'h2', providerId: 'SV1', title: 'Family dinner for up to 6', cat: 'Chefs',          price: 35, rating: 5.0, kind: 'service' },
    { id: 'SV1b', hostId: 'h2', providerId: 'SV1', title: 'Celebration catering',       cat: 'Chefs',          price: 28, rating: 5.0, kind: 'service' },
    { id: 'SV2a', hostId: 'h3', providerId: 'SV2', title: 'Grilled seafood feast',      cat: 'Chefs',          price: 42, rating: 4.9, kind: 'service' },
    { id: 'SV3a', hostId: 'h4', providerId: 'SV3', title: 'Event & wedding coverage',   cat: 'Photography',    price: 60, rating: 4.98, kind: 'service' },
    { id: 'SV3b', hostId: 'h4', providerId: 'SV3', title: 'Family portrait session',    cat: 'Photography',    price: 30, rating: 4.98, kind: 'service' },
    { id: 'SV4a', hostId: 'h6', providerId: 'SV4', title: 'Bridal henna',               cat: 'Beauty & Henna', price: 55, rating: 4.95, kind: 'service' },
    { id: 'SV4b', hostId: 'h6', providerId: 'SV4', title: 'Guest henna (per person)',   cat: 'Beauty & Henna', price: 12, rating: 4.95, kind: 'service' },
    { id: 'SV5a', hostId: 'h5', providerId: 'SV5', title: 'English / maths lesson',     cat: 'Tutoring',       price: 15, rating: 4.9, kind: 'service' },
    { id: 'SV5b', hostId: 'h5', providerId: 'SV5', title: 'Quran tutoring',             cat: 'Tutoring',       price: 14, rating: 4.9, kind: 'service' },
    { id: 'SV6a', hostId: 'h1', providerId: 'SV6', title: 'Deep clean',                 cat: 'Home & cleaning', price: 30, rating: 4.88, kind: 'service' },
    { id: 'SV6b', hostId: 'h1', providerId: 'SV6', title: 'Host turnover clean',        cat: 'Home & cleaning', price: 22, rating: 4.88, kind: 'service' },
  ];

  return {
    hosts,
    listings,
    experiences,
    services,
    bookings: [],
    otps: {},      // contact -> { code, expires, attempts }
    sessions: {},  // token   -> { contact, createdAt }
  };
}

module.exports = { freshData };
