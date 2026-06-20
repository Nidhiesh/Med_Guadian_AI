# Tasks

- [x] 1. Backend Updates (`server.js`)
  - [x] Auto-seed `admin@gmail.com` on server startup.
  - [x] Add `POST /api/admin/create-doctor` endpoint for Admin to insert doctors.
  - [x] Update `/api/auth/crypto/:role/challenge` to return `requiresSetup: true` if `public_key` is NULL.
  - [x] Update `/api/auth/crypto/:role/register` to `UPDATE` an existing user's `public_key` instead of inserting a new user.
- [x] 2. Login Frontend (`login.html`)
  - [x] Remove Staff Signup tab and HTML form.
  - [x] Update `handleStaffLogin` to catch `requiresSetup`, generate key pair, and call register automatically.
  - [x] Persistent Emergency QR code displayed on the login page for the last logged-in patient.
- [x] 3. Dashboard Frontend (`index.html`)
  - [x] Add UI to Admin Dashboard for creating a new Doctor account.
  - [x] Add JS function to submit the form to the backend.
