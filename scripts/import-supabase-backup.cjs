#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');
const admin = require('firebase-admin');

function decodeCopy(value) {
  if (value === '\\N') return null;
  return value.replace(/\\(\\|t|n|r|b|f|v|[0-7]{1,3}|x[0-9A-Fa-f]{1,2})/g, (_, esc) => {
    if (esc === '\\') return '\\';
    if (esc === 't') return '\t';
    if (esc === 'n') return '\n';
    if (esc === 'r') return '\r';
    if (esc === 'b') return '\b';
    if (esc === 'f') return '\f';
    if (esc === 'v') return '\v';
    if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
    return String.fromCharCode(parseInt(esc, 8));
  });
}
function readCopy(sql, table) {
  const escaped = table.replace(/\./g, '\\.');
  const re = new RegExp('COPY ' + escaped + ' \\(([^\\n]*)\\) FROM stdin;\\n([\\s\\S]*?)\\n\\\\\\.', 'm');
  const match = sql.match(re);
  if (!match) throw new Error('Sezione COPY non trovata: ' + table);
  const columns = match[1].split(',').map(x => x.trim().replace(/^"|"$/g, ''));
  return match[2].split('\n').filter(Boolean).map(line => {
    const values = line.split('\t').map(decodeCopy);
    if (values.length !== columns.length) throw new Error('Riga COPY non valida in ' + table);
    return Object.fromEntries(columns.map((key, i) => [key, values[i]]));
  });
}
function num(v) { return v == null ? null : Number(v); }
function parseJson(v, fallback) { return v == null ? fallback : JSON.parse(v); }

async function main() {
  const dumpPath = process.argv[2];
  if (!dumpPath) throw new Error('Uso: node scripts/import-supabase-backup.cjs <backup.sql.gz|backup.sql>');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Imposta GOOGLE_APPLICATION_CREDENTIALS con il percorso locale della chiave Admin SDK.');
  const raw = fs.readFileSync(dumpPath);
  const sql = dumpPath.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const users = readCopy(sql, 'auth.users');
  const horses = readCopy(sql, 'public.horses');
  const performances = readCopy(sql, 'public.performances');
  const profiles = readCopy(sql, 'public.profiles');

  admin.initializeApp({credential:admin.credential.applicationDefault()});
  const auth = admin.auth(), db = admin.firestore();
  const existingByEmail = new Map();
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    for (const user of page.users) if (user.email) existingByEmail.set(user.email.toLowerCase(), user);
    token = page.pageToken;
  } while (token);

  const uidMap = new Map(), toImport = [];
  for (const row of users) {
    if (!row.id || !row.email || !row.encrypted_password || row.encrypted_password === 'authenticate') {
      throw new Error('Un account Supabase non contiene una password bcrypt importabile.');
    }
    const existing = existingByEmail.get(row.email.toLowerCase());
    if (existing) uidMap.set(row.id, existing.uid);
    else {
      toImport.push({uid:row.id,email:row.email,emailVerified:row.email_confirmed_at != null,
        passwordHash:Buffer.from(row.encrypted_password, 'utf8'),disabled:false});
      uidMap.set(row.id, row.id);
    }
  }
  if (toImport.length) {
    const result = await auth.importUsers(toImport, {hash:{algorithm:'BCRYPT'}});
    if (result.failureCount) {
      const reasons = result.errors.map(e => ({index:e.index,error:e.error?.message || 'import error'}));
      throw new Error('Import utenti incompleto; Firestore NON importato. Dettagli: ' + JSON.stringify(reasons));
    }
  }
  const remap = id => uidMap.get(id) || id;
  const horseRows = horses.map(r => ({
    id:num(r.id),name:r.name,in_watchlist:r.in_watchlist === 't',userId:remap(r.user_id),profile_note:r.profile_note,
    sharedVisible:performances.some(p => num(p.horse_id) === num(r.id) && p.shared === 't')
  }));
  const perfRows = performances.map(r => ({
    id:num(r.id),horse_id:num(r.horse_id),race_date:r.race_date,track:r.track,distance:r.distance,going:r.going,
    rating:num(r.rating),tags:parseJson(r.tags,[]),notes:r.notes,created_at:r.created_at,userId:remap(r.user_id),
    race_type:r.race_type,shared:r.shared === 't'
  }));
  const profileRows = profiles.map(r => ({userId:remap(r.user_id),user_id:remap(r.user_id),display_name:r.display_name}));

  const batchWrite = async (collection, rows, idField) => {
    for (let start=0; start<rows.length; start+=400) {
      const batch=db.batch();
      for (const row of rows.slice(start,start+400)) batch.set(db.collection(collection).doc(String(row[idField])),row);
      await batch.commit();
    }
  };
  await batchWrite('horses',horseRows,'id');
  await batchWrite('performances',perfRows,'id');
  await batchWrite('profiles',profileRows,'userId');
  const maxHorse=Math.max(0,...horseRows.map(x=>x.id));
  const maxPerformance=Math.max(0,...perfRows.map(x=>x.id));
  await db.collection('_meta').doc('counters').set({
    nextHorseId:maxHorse+1,nextPerformanceId:maxPerformance+1,migratedAt:admin.firestore.FieldValue.serverTimestamp()
  },{merge:true});
  const counts=await Promise.all(['horses','performances','profiles'].map(async c=>({collection:c,count:(await db.collection(c).get()).size})));
  console.log(JSON.stringify({authUsersImported:toImport.length,authUsersLinked:users.length-toImport.length,
    sourceUsers:users.length,imported:{horses:horseRows.length,performances:perfRows.length,profiles:profileRows.length},
    firestoreCounts:counts},null,2));
}
main().catch(error=>{console.error('Migrazione interrotta:',error.message);process.exitCode=1;});
