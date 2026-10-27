# EventSphere Backend

Expo management API: Node.js, Express, MongoDB (Mongoose), JWT, Socket.IO, Cloudinary. **All APIs are in `app.js`**; schemas are in `models/`.

## 1. Setup
```
npm install
copy env.example to .env  (rename) and fill every value
npm run dev          # development (nodemon)
npm start            # production
npm test             # end-to-end test (server must be running)
npm run backup       # dump every collection to backups/<timestamp>/
```
Required `.env`: `MONGO_URL` (include `/eventsphere` database name), `JWT_SECRET` (long random string), `ADMIN_SIGNUP_CODE`, `EMAIL_USER` + `EMAIL_PASS` (Gmail App Password), `EMAIL_ADMIN` (receives new-registration alerts), `CLOUDINARY_*`, `CLIENT_URL` (optional, reset-link base).

## 2. Folder structure
```
app.js  package.json  .env
models/   User Expo Booth ExhibitorProfile Application Session Registration Message Feedback Notification
scripts/backup.js        tests/smoke.test.js        EventSphere.postman_collection.json
```

## 3. Roles
| Role | Can |
|---|---|
| admin / organizer | Manage expos, booths, schedule, applications, feedback, analytics, reports, users |
| exhibitor | Profile, apply, reserve booth, edit booth details, message, inquiries |
| attendee | Browse, register for expos/sessions, bookmark, search exhibitors, message, inquire |

Admin/organizer accounts need `adminCode` (= `ADMIN_SIGNUP_CODE`) at registration. Send `Authorization: Bearer <token>`.

## 4. API reference
| Area | Endpoints |
|---|---|
| Auth | `POST /register` `POST /login` `POST /forgot-password` `POST /reset-password/:token` `GET /api/me` `PUT /api/me` `PUT /api/change-password` |
| Privacy | `GET /api/me/export` `DELETE /api/me` |
| Users (admin) | `GET /api/users?role=&search=` |
| Expos | `POST/GET /api/expos` `GET/PUT/DELETE /api/expos/:id` `POST /api/expos/:id/register` |
| Booths | `POST/GET /api/booths` `GET /api/booths/expo/:expoId` `GET /api/booths/my/list` `GET/PUT/DELETE /api/booths/:id` `PUT /api/booths/:id/assign` `/reserve` `/release` `/details` `GET /api/booths/:id/neighbors` |
| Exhibitors | `GET/PUT /api/exhibitors/profile` `POST /api/applications` `GET /api/applications/my` `GET /api/applications` `PUT /api/applications/:id/status` `GET /api/expos/:expoId/exhibitors?search=&category=` `POST /api/exhibitors/:id/inquiry` |
| Schedule | `POST/GET /api/sessions` `GET/PUT/DELETE /api/sessions/:id` `POST/DELETE /api/sessions/:id/register` `/bookmark` `GET /api/registrations/my` |
| Messaging | `POST /api/messages` `GET /api/messages/inbox` `GET /api/messages/:userId` |
| Notifications | `GET /api/notifications` `PUT /api/notifications/read` |
| Feedback | `POST /api/feedback` `GET /api/feedback` `PUT /api/feedback/:id` |
| Analytics / Reports | `GET /api/analytics/:expoId` `GET /api/reports/:expoId?type=attendees|booths|sessions|applications&format=csv` |
| Upload | `POST /api/upload?folder=logos|documents|floorplans` (form-data field `file`, 5 MB, images/PDF) |
| Ops | `GET /health` |

**Real-time (Socket.IO):** connect with `io(URL,{auth:{token}})`, then `emit("join-expo", expoId)`. Events: `booth-updated`, `schedule-updated`, `expo-updated`, `new-message`, `new-notification`, `analytics-update` (admins).

## 5. SRS coverage
| Requirement | Implementation |
|---|---|
| Registration/login, roles | `/register`, `/login`, role enum, admin code |
| Password reset, encryption | forgot/reset (15-min JWT, email), bcrypt |
| Expo CRUD, details, theme | `/api/expos` |
| Allocate booths on floor plan | booths with `position {x,y,w,h}`, `floorPlanImage`, assign/reserve/release |
| Exhibitor approvals | applications + approve/reject + notification |
| Schedule, speakers, updates | `/api/sessions`, attendees notified on change |
| Analytics & reports, real-time | `/api/analytics`, `/api/reports` (JSON/CSV), socket `analytics-update` |
| Exhibitor profile, documents | profile + Cloudinary upload |
| Booth selection/management | reserve (atomic, no double-booking), details, staff |
| Communication, neighbors | messages, inquiries (chat+email), `/neighbors` with contact info |
| Attendee search/filter, floor plan | `/exhibitors?search&category`, booth locations |
| Bookmark/register, reminders | register/bookmark, 15-minute reminder job |
| Real-time updates | Socket.IO |
| Feedback & support | `/api/feedback` |
| Performance, indexes, scalability | DB indexes, stateless JWT (add Redis adapter for multi-instance sockets) |
| Security | bcrypt, JWT, RBAC, helmet, rate limiting, CORS, input checks |
| GDPR, consent | consent at signup, export, delete account |
| Logging/monitoring | morgan request log, error handler, `/health` |
| Backups | `npm run backup` (schedule it) + Atlas backups |
| Tests, docs | `npm test`, Postman collection, this README |
| Uptime, TLS | Deploy behind HTTPS (Render/Railway/Nginx), process manager (PM2); graceful shutdown built in |
| UI, accessibility (WCAG), browsers, mobile | Frontend scope; API is JSON and CORS-enabled |

## 6. User guide / FAQ
- **Organizer:** register with the admin code, create an expo, add booths, review applications, publish sessions, watch analytics, download reports.
- **Exhibitor:** register, complete profile, apply to an expo, wait for approval, reserve a booth, add booth details, chat with neighbors and visitors.
- **Attendee:** register, register for the expo, search exhibitors, bookmark sessions, get reminders, send inquiries.
- *Forgot password?* `POST /forgot-password`, then use the emailed token in `POST /reset-password/:token`.
- *Cannot reserve a booth?* You need an approved application for that expo.
- *Delete my data?* `DELETE /api/me`.

## 7. Demo video script (record with Postman)
1. Start server. 2. Register admin/exhibitor/attendee (show admin email). 3. Create expo and booths. 4. Exhibitor applies, admin approves, exhibitor reserves. 5. Attendee searches and registers, books session. 6. Update session and show notification. 7. Messages and inquiry. 8. Analytics and CSV report. 9. Export and delete account.
