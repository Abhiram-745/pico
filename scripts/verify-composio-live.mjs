// Read-only verification. Does not load dotenv, access the OS secret store, or create sessions.
if (!process.env.COMPOSIO_API_KEY) {
  console.log('Live verification blocked: COMPOSIO_API_KEY is absent from process.env. No secret store was accessed.');
} else {
  try {
    const { Composio } = await import('@composio/core');
    const sdk = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
    const response = await sdk.connectedAccounts.list({ userIds: [process.env.HALO_COMPOSIO_USER_ID || 'halo-local'], toolkitSlugs: ['gmail', 'outlook', 'googlecalendar', 'slack'], accountType: 'PRIVATE', limit: 100 });
    const statuses = {};
    for (const account of response.items) {
      const status = ['ACTIVE','INITIALIZING','INITIATED','FAILED','EXPIRED','INACTIVE','REVOKED'].includes(account.status) ? account.status : 'OTHER';
      statuses[status] = (statuses[status] || 0) + 1;
    }
    console.log(JSON.stringify({ count: response.items.length, statuses, paginated: Boolean(response.nextCursor) }));
  } catch { console.log('Live verification blocked: SDK unavailable or read-only list request failed. No remote error body printed.'); process.exitCode = 1; }
}
