// End-to-end test. Start the server first (npm run dev), then run:  npm test
// Needs ADMIN_SIGNUP_CODE in .env. Uses BASE_URL (default http://localhost:3000)
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert");

const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const run = Date.now();
const s = {}; // shared state

const api = async (method, path, token, body) => {
    const res = await fetch(BASE + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
};

const signup = async (key, role, extra = {}) => {
    const email = `${key}${run}@test.com`;
    const r = await api("POST", "/register", null, { name: key, email, password: "secret123", role, consent: true, ...extra });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const l = await api("POST", "/login", null, { email, password: "secret123" });
    assert.strictEqual(l.status, 200);
    s[key] = { token: l.body.token, id: l.body.user.id };
};

test("health", async () => assert.strictEqual((await api("GET", "/health")).status, 200));

test("registration, roles and login", async () => {
    const bad = await api("POST", "/register", null, { name: "x", email: `bad${run}@test.com`, password: "secret123", role: "admin", adminCode: "wrong" });
    assert.strictEqual(bad.status, 403);
    await signup("admin", "admin", { adminCode: process.env.ADMIN_SIGNUP_CODE });
    await signup("exhibitor", "exhibitor");
    await signup("attendee", "attendee");
    assert.strictEqual((await api("GET", "/api/me")).status, 401);
    assert.strictEqual((await api("GET", "/api/me", s.admin.token)).status, 200);
});

test("expo + booth management (admin only)", async () => {
    const deny = await api("POST", "/api/expos", s.attendee.token, { title: "x" });
    assert.strictEqual(deny.status, 403);
    const e = await api("POST", "/api/expos", s.admin.token, { title: "Test Expo", location: "Karachi", startDate: "2026-12-10", endDate: "2026-12-12" });
    assert.strictEqual(e.status, 201); s.expoId = e.body.expo._id;
    const b = await api("POST", "/api/booths", s.admin.token, { expoId: s.expoId, boothNumber: "A1", size: "3x3", location: "Hall A", price: 100 });
    assert.strictEqual(b.status, 201); s.boothId = b.body.booth._id;
    assert.strictEqual((await api("POST", "/api/booths", s.admin.token, { expoId: s.expoId, boothNumber: "A1", size: "3x3", location: "Hall A", price: 100 })).status, 400);
});

test("exhibitor application -> approval -> booth reservation", async () => {
    assert.strictEqual((await api("PUT", `/api/booths/${s.boothId}/reserve`, s.exhibitor.token)).status, 403);
    const a = await api("POST", "/api/applications", s.exhibitor.token, { expoId: s.expoId, companyName: "TechCorp", category: "Tech", products: ["Robots"] });
    assert.strictEqual(a.status, 201); s.appId = a.body.application._id;
    assert.strictEqual((await api("PUT", `/api/applications/${s.appId}/status`, s.admin.token, { status: "approved" })).status, 200);
    const r = await api("PUT", `/api/booths/${s.boothId}/reserve`, s.exhibitor.token);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.booth.status, "reserved");
    assert.strictEqual((await api("PUT", `/api/booths/${s.boothId}/reserve`, s.exhibitor.token)).status, 409);
    assert.strictEqual((await api("PUT", `/api/booths/${s.boothId}/assign`, s.admin.token, { exhibitorId: s.exhibitor.id })).status, 200);
});

test("attendee search, registration, schedule", async () => {
    const f = await api("GET", `/api/expos/${s.expoId}/exhibitors?search=robot`);
    assert.strictEqual(f.body.exhibitors.length, 1);
    assert.strictEqual((await api("POST", `/api/expos/${s.expoId}/register`, s.attendee.token)).status, 201);
    const ses = await api("POST", "/api/sessions", s.admin.token, { expoId: s.expoId, title: "Keynote", speaker: "Dr. Khan", startTime: "2026-12-10T10:00:00Z", endTime: "2026-12-10T11:00:00Z", capacity: 10 });
    assert.strictEqual(ses.status, 201); s.sessionId = ses.body.session._id;
    assert.strictEqual((await api("POST", `/api/sessions/${s.sessionId}/register`, s.attendee.token)).status, 201);
    assert.strictEqual((await api("POST", `/api/sessions/${s.sessionId}/bookmark`, s.attendee.token)).status, 201);
    await api("PUT", `/api/sessions/${s.sessionId}`, s.admin.token, { location: "Hall B" });
    const n = await api("GET", "/api/notifications", s.attendee.token);
    assert.ok(n.body.notifications.some((x) => x.title === "Session updated"));
});

test("messaging, inquiry, feedback", async () => {
    assert.strictEqual((await api("POST", "/api/messages", s.attendee.token, { receiverId: s.exhibitor.id, text: "Hello" })).status, 201);
    assert.strictEqual((await api("POST", "/api/messages", s.attendee.token, { receiverId: s.attendee.id, text: "self" })).status, 403);
    assert.strictEqual((await api("POST", `/api/exhibitors/${s.exhibitor.id}/inquiry`, s.attendee.token, { message: "Demo?" })).status, 201);
    assert.strictEqual((await api("GET", "/api/messages/inbox", s.exhibitor.token)).status, 200);
    assert.strictEqual((await api("POST", "/api/feedback", s.attendee.token, { message: "Nice" })).status, 201);
});

test("analytics, reports, privacy", async () => {
    const a = await api("GET", `/api/analytics/${s.expoId}`, s.admin.token);
    assert.strictEqual(a.status, 200); assert.ok(a.body.attendeeEngagement.registeredAttendees >= 1);
    assert.strictEqual((await api("GET", `/api/reports/${s.expoId}?type=sessions&format=csv`, s.admin.token)).status, 200);
    assert.strictEqual((await api("GET", `/api/analytics/${s.expoId}`, s.attendee.token)).status, 403);
    assert.strictEqual((await api("GET", "/api/me/export", s.attendee.token)).status, 200);
    assert.strictEqual((await api("DELETE", "/api/me", s.attendee.token)).status, 200);
});

test("cleanup", async () => {
    assert.strictEqual((await api("DELETE", `/api/expos/${s.expoId}`, s.admin.token)).status, 200);
});
