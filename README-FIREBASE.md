# Horse Diary — migrazione Firebase

Questa branch sostituisce Supabase con Firebase Authentication (email/password) e Cloud Firestore.

## File aggiunti
- `firestore.rules`: regole per dati privati e condivisi.
- `scripts/import-supabase-backup.cjs`: importa il dump PostgreSQL compresso di Supabase in Firestore e tenta l'import degli utenti con hash bcrypt.
- `.gitignore`: esclude credenziali amministrative e backup.

## Prima del rilascio
1. In Firebase Console abilita **Authentication → Sign-in method → Email/Password**.
2. Pubblica `firestore.rules` in Firestore → Rules.
3. Crea una chiave privata Firebase Admin SDK da Project settings → Service accounts. Salvala localmente, fuori dal repository.
4. Non caricare mai la chiave Admin SDK o il dump nel repository.
5. Esegui l'importazione in locale (Node.js 18+):
   ```bash
   npm install firebase-admin
   export GOOGLE_APPLICATION_CREDENTIALS="/percorso/locale/service-account.json"
   node scripts/import-supabase-backup.cjs "/percorso/locale/db_cluster.backup.gz"
   ```
6. Controlla Firestore: 8 cavalli, 8 performance e 2 profili; controlla Authentication per i due utenti.
7. Prova entrambi gli account, creazione/modifica/eliminazione note, watchlist e condivisione prima del rilascio.

## Account e password
Lo script conserva gli UID Supabase quando può importare gli utenti e usa gli hash bcrypt del dump. Se trova già un utente Firebase con la stessa email, riutilizza il suo UID e rimappa i documenti. Se Firebase rifiuta un hash o un account, lo script si ferma prima di importare i dati e non cancella gli account esistenti. In quel caso pianifica un reset password; non disabilitare Supabase finché entrambi gli accessi non sono verificati.

## Attenzione
- La configurazione web Firebase in `index.html` è pubblica per definizione; la sicurezza è demandata alle regole Firestore.
- I dati Supabase originali non vengono cancellati.
- Non pubblicare questa branch prima di completare import e test.
