# 🛠️ Fixit - On-Demand Home Repair & Service Platform

**Fixit** is a modern, responsive web application connecting homeowners and tenants with certified, background-checked repair professionals across multiple trades (plumbing, electrical, carpentry, AC repair, appliances, and painting).

---

## 🚀 Quick Start

To start the server, open a terminal in this directory and run:

```powershell
agy-node server.js
```

Or double-click `start.bat`.

Then visit:
👉 **`http://localhost:3000`**

---

## ⚡ Instant Demo Switcher

A quick-switch test banner is embedded at the top of the application for effortless role evaluation without typing passwords:

- 👤 **Customer (Alice Morgan)**: Explore categories, submit complaints with photos, track requests in real-time, view service history, and leave 5-star reviews.
- 🔧 **Provider (Mike Vance - Master Plumber)**: Manage technician profile, view incoming local complaints, accept/reject jobs, start work, and complete jobs with final bills.
- ⏳ **Provider (Pending Review - Sam)**: Experience the provider registration workflow awaiting admin review.
- 🛡️ **Admin (Super Admin)**: Live statistics, Chart.js analytics, approve/reject provider applications, manage users, add categories, and monitor reviews.

---

## 📋 Comprehensive Feature Checklist

### 1. User (Customer) Features
- [x] **User Registration & Login**: Role-based authentication with session tokens.
- [x] **Report a Problem**: Form with Title, Category, Description, Photo upload (with camera preview), Preferred Date & Time, Address, and Urgency level.
- [x] **Service Categories**: Plumbing, Electrical, Carpentry, AC Repair, Appliance Repair, Painting & Waterproofing.
- [x] **Book a Service**: Direct booking with specific specialists or general category requests.
- [x] **Track Requests**: 4-state visual lifecycle tracker (`Pending` → `Accepted` → `In Progress` → `Completed`, or `Rejected`).
- [x] **Service History**: Search and filter past and active service complaints with invoices.
- [x] **Ratings & Reviews**: 5-star interactive rating and written feedback modal after service completion.
- [x] **Notifications**: Live notification bell with unread badge counter for status updates.

### 2. Service Provider Features
- [x] **Provider Registration**: Includes trade specialty, hourly rate, years of experience, and skills.
- [x] **Profile Management**: Update rate ($/hr), experience, skills tags, bio, phone, and availability status.
- [x] **Incoming Repair Requests**: Matched to the technician's specialty and operating zone.
- [x] **Accept or Reject Requests**: One-click acceptance or decline with reason dialog.
- [x] **Update Repair Status**: Single-click progression to `In Progress`, and `Complete Repair` with notes and final cost.
- [x] **Ratings & Feedback**: Live average star rating and review count calculated dynamically.
- [x] **Job Management**: Metric cards for Pending, Active, and Completed jobs.

### 3. Admin Features
- [x] **Admin Dashboard with Statistics**: Total Requests, In Progress, Completed, Registered Users, Pending Approvals, and Platform Revenue.
- [x] **Interactive Visual Analytics**: Chart.js graphs for Requests by Category and Status Distribution.
- [x] **Manage Registered Users**: View user table, role, order count, and suspend/reactivate accounts.
- [x] **Manage Service Providers**: Review credentials and 1-click **Approve** or **Reject** pending provider registrations.
- [x] **View & Manage All Requests**: Platform-wide master complaint ledger with live statuses.
- [x] **Manage Service Categories**: Modal to add new trades with custom icons, descriptions, and base prices.
- [x] **Review Moderation**: Live feed of all customer reviews and ratings across all providers.

### 4. Additional Features & Upgrades
- [x] **Independent Customer-Provider Live Chat**: Real-time messaging on any request stage (`Pending`, `Accepted`, `In Progress`, `Completed`).
- [x] **Offline Payment Negotiation**: Propose custom rates ($) in chat and click **"Agree Offline Deal"** for in-person cash payment upon completion.
- [x] **1-Click Testing Role Switcher**: Instant `[ 🔄 Reply as Provider / Customer ]` toggle inside the chat modal for testing two-way communication without logging out.
- [x] **Persistent SQLite Sessions & WAL Mode**: High concurrency Write-Ahead Logging (`PRAGMA journal_mode = WAL`) preventing database locks when viewed via VS Code SQLite Viewer.
- [x] **Auto-Sync Engine**: Seamlessly pushes any offline/browser-cached accounts and requests straight into `fixit.db`.
- [x] Search & filter service providers by keyword and category.
- [x] Image upload with drag & drop and thumbnail preview.
- [x] Fully mobile-friendly responsive layout with Tailwind CSS.
- [x] Embedded zero-dependency SQLite database (`node:sqlite`).

---

## 🗄️ Database Architecture (`fixit.db`)

Built using Node.js built-in `node:sqlite` (`DatabaseSync`):
- `users`: Authentication, credentials, role, status, contact details.
- `categories`: Service trades, base fees, FontAwesome icons.
- `providers`: Linked to `users`, hourly rates, skills JSON, verification status, rating.
- `requests`: Service tickets, statuses, preferred schedule, damage photos, completion notes, costs.
- `reviews`: Customer feedback, star ratings, timestamps.
- `notifications`: Status change alerts and admin announcements.

---

## 🔑 Pre-Seeded Test Credentials

| Role | Email | Password | Details |
|---|---|---|---|
| **Admin** | `admin@fixit.com` | `password123` | Platform Admin |
| **Customer** | `alice@fixit.com` | `password123` | Customer with active & completed requests |
| **Customer** | `david@fixit.com` | `password123` | Customer with pending AC repair |
| **Provider** | `mike@fixit.com` | `password123` | Master Plumber (4.9 ★) |
| **Provider** | `elena@fixit.com` | `password123` | Licensed Electrician (4.8 ★) |
| **Provider** | `sam@fixit.com` | `password123` | Pending Verification Provider |

---

## 🌐 24/7 Cloud Deployment Guide

Because Fixit runs with native **Node.js (v22+)** and embedded **SQLite**, it requires zero build steps or npm installations.

### Deploying to Render.com (Free 24/7 Hosting)
1. Push this repository to GitHub.
2. Sign in to [Render.com](https://render.com) and click **New +** → **Web Service**.
3. Select your GitHub repository.
4. Set the following settings:
   - **Runtime**: `Node` (or `Docker`)
   - **Build Command**: Leave empty or `echo "Ready"`
   - **Start Command**: `node server.js`
5. In **Environment Variables**, add:
   - `PORT`: `3000`
   - `SMTP_USER`: `your_gmail@gmail.com` (optional)
   - `SMTP_PASS`: `your_app_password` (optional)
6. Click **Deploy Web Service**.
7. **Keep Awake Forever**: Render's free tier sleeps after 15 mins of inactivity. Register a free monitor on [UptimeRobot.com](https://uptimerobot.com) to ping `https://your-service.onrender.com/api/categories` every 5-10 minutes to keep it alive 24/7!
