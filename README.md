## Sandbox Linear + GitHub webhook server

Simple Node.js/Express server for testing Linear and GitHub webhooks locally.

### 1. Install & run locally

1. **Install dependencies**

```bash
cd /Users/girishverma/Developer/claude_analytics
npm install
```

2. **Create your `.env`**

```bash
cp .env.example .env
```

Edit `.env` if you want to change the port or add secrets later.

3. **Start the server**

```bash
npm run start
# or for auto-reload during development:
npm run dev
```

Server will listen on `http://localhost:3000` by default.

Endpoints:
- `GET /health`
- `POST /webhooks/github`
- `POST /webhooks/linear`

### 2. Expose a public URL for webhooks

You can use **either ngrok or smee.io**.

#### Option A: ngrok

1. **Install ngrok** (if you don’t already have it)

Follow instructions at `https://ngrok.com/download`.

2. **Start ngrok tunnel**

```bash
ngrok http 3000
```

3. ngrok will print a forwarding URL, e.g.:

```text
Forwarding                    https://abcd1234.ngrok.io -> http://localhost:3000
```

Use this URL in the webhook configuration:

- GitHub: `https://abcd1234.ngrok.io/webhooks/github`
- Linear: `https://abcd1234.ngrok.io/webhooks/linear`

#### Option B: smee.io

1. Go to `https://smee.io` and click **Start a new channel**.

2. Copy the **Smee channel URL**, e.g.:

```text
https://smee.io/your-random-channel-id
```

3. Install the smee client:

```bash
npm install -g smee-client
```

4. Run the client to forward events to your local server:

```bash
smee -u https://smee.io/your-random-channel-id -t http://localhost:3000
```

This will forward:

- GitHub webhook URL: `https://smee.io/your-random-channel-id/webhooks/github`
- Linear webhook URL: `https://smee.io/your-random-channel-id/webhooks/linear`

### 3. Configure GitHub webhook

1. Go to your GitHub **repo** → **Settings** → **Webhooks** → **Add webhook**.
2. **Payload URL**: use your public URL:
   - `https://<your-ngrok-or-smee-url>/webhooks/github`
3. **Content type**: `application/json`.
4. **Secret**: optional for now (if you add one, also set `GITHUB_WEBHOOK_SECRET` in `.env` and implement verification).
5. **Which events?**:
   - Start simple: “Just the push event”, or choose the events you want to test.
6. Click **Add webhook** and then trigger an event (e.g. push a commit).

You should see logs in your Node process with the GitHub payload details.

### 4. Configure Linear webhook

1. In Linear, go to **Settings** → **API** → **Webhooks**.
2. Create a **New webhook**.
3. **URL**:
   - `https://<your-ngrok-or-smee-url>/webhooks/linear`
4. Choose the events you want (e.g. issue created/updated).
5. (Optional) Set a secret and then set `LINEAR_WEBHOOK_SECRET` in `.env` and implement verification.

Trigger an event in Linear and watch your server logs.

### 5. Next steps (optional)

- Implement **signature verification** for:
  - GitHub: `X-Hub-Signature-256` header with `GITHUB_WEBHOOK_SECRET`.
  - Linear: `Linear-Signature` header with `LINEAR_WEBHOOK_SECRET`.
- Add routing/logic to:
  - Sync Linear issues with GitHub issues or pull requests.
  - Post comments or status updates between systems.

