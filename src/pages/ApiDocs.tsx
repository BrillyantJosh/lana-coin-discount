import { Link } from 'react-router-dom';

const ApiDocs = () => {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="container mx-auto px-6 flex items-center justify-between h-16">
          <Link to="/" className="flex items-center gap-2 text-xl font-display font-bold text-primary">
            <img src="/lana-logo.png" alt="Lana" className="h-8 w-8 dark:invert" />
            <span>Lana<span className="text-gold">.Discount</span></span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Home
            </Link>
            <Link
              to="/login"
              className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Sign In
            </Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <div className="flex-1 container mx-auto px-4 sm:px-6 py-8 sm:py-12 max-w-4xl">
        <div className="mb-8 sm:mb-10 space-y-3">
          <h1 className="text-2xl sm:text-4xl font-bold text-foreground">API Documentation</h1>
          <p className="text-lg text-muted-foreground">
            Integrate your application with Lana.Discount to submit LanaCoin buyback transactions programmatically.
          </p>
        </div>

        {/* Overview */}
        <Section title="Overview">
          <p>
            The Lana.Discount External API allows authorized applications to report completed LanaCoin sale
            transactions. When a sale is submitted through the API, it is stored with a <Code>pending_verification</Code> status.
            An administrator must then verify the transaction before payouts can be processed.
          </p>
          <p className="mt-3">
            This ensures that all externally reported transactions are reviewed and confirmed before any
            financial obligations are recorded.
          </p>
        </Section>

        {/* Authentication */}
        <Section title="Authentication">
          <p>
            All API requests require a valid API key. Keys are created by administrators through the
            admin panel at <Code>/admin/api-keys</Code>. Each key is associated with a specific application name
            for tracking and auditing purposes.
          </p>
          <p className="mt-3">
            Include your API key in the <Code>Authorization</Code> header using the Bearer scheme:
          </p>
          <CodeBlock>{`Authorization: Bearer ldk_your_api_key_here`}</CodeBlock>
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-800">
              <span className="font-bold">Important:</span> API keys are shown only once at creation time.
              Store your key securely. If lost, deactivate the old key and create a new one.
              Keys are stored as SHA-256 hashes and cannot be recovered.
            </p>
          </div>
          <h3 className="mt-6 text-lg font-semibold text-foreground">Key Format</h3>
          <p className="mt-1">
            All API keys use the prefix <Code>ldk_</Code> followed by 48 hexadecimal characters,
            for a total length of 52 characters. Example:
          </p>
          <CodeBlock>{`ldk_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4`}</CodeBlock>
        </Section>

        {/* Base URL */}
        <Section title="Base URL">
          <CodeBlock>{`https://www.lana.discount/api`}</CodeBlock>
          <p className="mt-2 text-sm text-muted-foreground">
            All endpoints are relative to this base URL.
          </p>
        </Section>

        {/* Endpoints */}
        <Section title="Endpoints">
          {/* POST /external/sale */}
          <div className="rounded-xl border-2 border-border bg-card p-6 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-green-100 text-green-700 text-xs font-bold font-mono uppercase">
                POST
              </span>
              <code className="text-lg font-mono font-bold text-foreground">/external/sale</code>
            </div>
            <p className="text-muted-foreground mb-4">
              Submit a completed LanaCoin sale transaction. The transaction will be recorded
              with <Code>pending_verification</Code> status until an administrator verifies it.
            </p>

            <h4 className="font-semibold text-foreground mt-6 mb-3">Request Headers</h4>
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Header</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr>
                    <td className="px-4 py-2 font-mono text-sm">Authorization</td>
                    <td className="px-4 py-2 font-mono text-sm">Bearer ldk_your_key</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2 font-mono text-sm">Content-Type</td>
                    <td className="px-4 py-2 font-mono text-sm">application/json</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h4 className="font-semibold text-foreground mt-6 mb-3">Request Body</h4>
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Field</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Type</th>
                    <th className="text-center px-4 py-2 font-medium text-muted-foreground">Required</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <ParamRow name="tx_hash" type="string" required description="The blockchain transaction hash (txid) of the completed LanaCoin transfer." />
                  <ParamRow name="sender_wallet_id" type="string" required description="The LanaCoin address that sent the coins (starts with L)." />
                  <ParamRow name="buyback_wallet_id" type="string" required description="The LanaCoin address that received the coins (the buyback wallet)." />
                  <ParamRow name="lana_amount" type="number" required description="Amount of LANA transferred, in whole coins (e.g. 500000 for 500K LANA)." />
                  <ParamRow name="currency" type="string" required description="The fiat currency for the payout (e.g. EUR, USD, GBP)." />
                  <ParamRow name="exchange_rate" type="number" required description="The LANA-to-fiat exchange rate used (e.g. 0.000008 means 1 LANA = 0.000008 EUR)." />
                  <ParamRow name="commission_percent" type="number" description="Commission percentage deducted from gross payout. Defaults to 30 if not provided." />
                  <ParamRow name="user_hex_id" type="string" description="The Nostr hex public key (64 chars) of the selling user. If omitted, an auto-generated ID is used." />
                  <ParamRow name="tx_fee_lanoshis" type="number" description="Transaction fee in lanoshis (1 LANA = 100,000,000 lanoshis). Defaults to 0." />
                </tbody>
              </table>
            </div>

            <h4 className="font-semibold text-foreground mt-6 mb-3">Example Request</h4>
            <CodeBlock>{`curl -X POST https://www.lana.discount/api/external/sale \\
  -H "Authorization: Bearer ldk_a1b2c3d4e5f6..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "tx_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "sender_wallet_id": "LWsenderAddress1234567890abcdef",
    "buyback_wallet_id": "LBuybackAddress1234567890abcdef",
    "lana_amount": 500000,
    "currency": "EUR",
    "exchange_rate": 0.000008,
    "commission_percent": 30,
    "user_hex_id": "56e8670aa65491f8595dc3a71c94aa7445dcdca755ca5f77c07218498a362061",
    "tx_fee_lanoshis": 1500000
  }'`}</CodeBlock>

            <h4 className="font-semibold text-foreground mt-6 mb-3">Success Response (201)</h4>
            <CodeBlock>{`{
  "success": true,
  "transactionId": 42,
  "status": "pending_verification",
  "grossFiat": 4.00,
  "commissionFiat": 1.20,
  "netFiat": 2.80
}`}</CodeBlock>

            <h4 className="font-semibold text-foreground mt-6 mb-3">Financial Calculation</h4>
            <p className="text-sm text-muted-foreground mb-2">
              The server calculates financial values from the submitted data:
            </p>
            <div className="rounded-lg bg-muted/30 p-4 font-mono text-sm space-y-1">
              <p><span className="text-muted-foreground">grossFiat</span> = lana_amount × exchange_rate</p>
              <p><span className="text-muted-foreground">commissionFiat</span> = grossFiat × (commission_percent / 100)</p>
              <p><span className="text-muted-foreground">netFiat</span> = grossFiat - commissionFiat</p>
            </div>

            <h4 className="font-semibold text-foreground mt-6 mb-3">Error Responses</h4>
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Condition</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr><td className="px-4 py-2 font-mono">400</td><td className="px-4 py-2">Missing or invalid required field</td></tr>
                  <tr><td className="px-4 py-2 font-mono">401</td><td className="px-4 py-2">Missing, invalid, or disabled API key</td></tr>
                  <tr><td className="px-4 py-2 font-mono">409</td><td className="px-4 py-2">A transaction with this tx_hash already exists (duplicate prevention)</td></tr>
                  <tr><td className="px-4 py-2 font-mono">500</td><td className="px-4 py-2">Internal server error</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* GET /external/sale/:id */}
          <div className="rounded-xl border-2 border-border bg-card p-6">
            <div className="flex items-center gap-3 mb-4">
              <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-blue-100 text-blue-700 text-xs font-bold font-mono uppercase">
                GET
              </span>
              <code className="text-lg font-mono font-bold text-foreground">/external/sale/:id</code>
            </div>
            <p className="text-muted-foreground mb-4">
              Check the current status of a previously submitted transaction.
            </p>

            <h4 className="font-semibold text-foreground mt-4 mb-3">Path Parameters</h4>
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Parameter</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="px-4 py-2 font-mono">id</td><td className="px-4 py-2">The <Code>transactionId</Code> returned from the POST request</td></tr>
                </tbody>
              </table>
            </div>

            <h4 className="font-semibold text-foreground mt-6 mb-3">Example Request</h4>
            <CodeBlock>{`curl https://www.lana.discount/api/external/sale/42 \\
  -H "Authorization: Bearer ldk_a1b2c3d4e5f6..."`}</CodeBlock>

            <h4 className="font-semibold text-foreground mt-6 mb-3">Success Response (200)</h4>
            <CodeBlock>{`{
  "transactionId": 42,
  "status": "pending_verification",
  "lanaAmount": 500000,
  "currency": "EUR",
  "netFiat": 2.80,
  "txHash": "e3b0c44298fc...",
  "verifiedAt": null,
  "createdAt": "2026-03-17 14:30:00"
}`}</CodeBlock>
          </div>
        </Section>

        {/* Transaction Lifecycle */}
        <Section title="Transaction Lifecycle">
          <p className="mb-4">
            Every transaction submitted through the external API follows this lifecycle:
          </p>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-0">
            <StatusStep label="pending_verification" color="orange" description="Submitted via API, awaiting admin review" />
            <Arrow />
            <StatusStep label="completed" color="green" description="Verified by admin, eligible for payout" />
            <Arrow />
            <StatusStep label="paid" color="emerald" description="All payout installments recorded" />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <StatusStep label="pending_verification" color="orange" description="" />
            <Arrow />
            <StatusStep label="failed" color="red" description="Rejected by admin (reason provided)" />
          </div>
          <div className="mt-6 rounded-lg border border-border bg-muted/20 p-4">
            <h4 className="font-semibold text-foreground mb-2">Status Descriptions</h4>
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="font-mono font-bold text-orange-600 w-48 flex-shrink-0">pending_verification</dt>
                <dd className="text-muted-foreground">The transaction has been received but not yet verified. An administrator must confirm that the blockchain transaction is valid and that funds were actually received.</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-mono font-bold text-green-600 w-48 flex-shrink-0">completed</dt>
                <dd className="text-muted-foreground">The transaction has been verified by an administrator. Payout installments can now be recorded against this transaction.</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-mono font-bold text-emerald-600 w-48 flex-shrink-0">paid</dt>
                <dd className="text-muted-foreground">All payout installments have been recorded and the total paid amount equals or exceeds the net fiat owed.</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-mono font-bold text-red-600 w-48 flex-shrink-0">failed</dt>
                <dd className="text-muted-foreground">The transaction was rejected by an administrator, typically because the blockchain transaction could not be confirmed or the data was incorrect.</dd>
              </div>
            </dl>
          </div>
        </Section>

        {/* Rate Limits & Best Practices */}
        <Section title="Best Practices">
          <ul className="list-disc list-inside space-y-2 text-foreground/80">
            <li>Store your API key securely and never expose it in client-side code or public repositories.</li>
            <li>Always include a valid <Code>tx_hash</Code> — duplicate hashes are rejected to prevent double-counting.</li>
            <li>Use the GET endpoint to poll for status changes after submission rather than resubmitting.</li>
            <li>Provide a <Code>user_hex_id</Code> whenever possible so that transactions are correctly attributed to users in the admin payout interface.</li>
            <li>If a key is compromised, immediately disable it in the admin panel and create a new one.</li>
          </ul>
        </Section>
      </div>

        {/* Brain Integration */}
        <Section title="Brain Integration API">
          <p className="mb-3">
            These endpoints are used by <a href="https://brain.lanapays.us/docs" className="text-primary hover:underline font-semibold">Lana Brain</a> to orchestrate LANA transfers as part of the purchase flow. They use the same API key authentication as the external API.
          </p>

          <h3 className="text-lg font-semibold text-foreground mt-6 mb-2">POST /api/brain/lana-order</h3>
          <p>Receives a LANA send order from Brain. The order is queued for processing.</p>
          <CodeBlock>{`Request:
{
  "order_id": "uuid",
  "tx_ref": "brain_transaction_uuid",
  "order_type": "investor_lana|customer_cashback|merchant_commission|caretaker_commission",
  "to_wallet": "LM7uDL...",
  "to_hex": "56e867...",
  "lana_amount": 625000000000,    // in lanoshis
  "fiat_value": 100,
  "currency": "EUR",
  "exchange_rate": 0.016
}

Response:
{ "status": "pending", "order_id": "uuid", "buyback_wallet": "LXy8Fq..." }`}</CodeBlock>

          <h3 className="text-lg font-semibold text-foreground mt-6 mb-2">GET /api/brain/lana-order/:id</h3>
          <p>Check the status of a LANA order.</p>
          <CodeBlock>{`Response:
{
  "status": "pending|sent|confirmed|failed",
  "order_id": "uuid",
  "tx_hash": "abc123...",
  "lana_amount": 625000000000,
  "to_wallet": "LM7uDL..."
}`}</CodeBlock>

          <h3 className="text-lg font-semibold text-foreground mt-6 mb-2">GET /api/brain/buyback-balance</h3>
          <p>Returns the current LANA balance of the buyback wallet.</p>
          <CodeBlock>{`Response:
{
  "wallet": "LXy8Fq...",
  "balance": 1250000.50,
  "unconfirmed": 0
}`}</CodeBlock>
        </Section>

        {/* Connected Services */}
        <Section title="Connected Services">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <a href="https://brain.lanapays.us/docs" target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-border p-4 hover:border-primary transition">
              <h3 className="font-semibold text-foreground">Lana Brain</h3>
              <p className="mt-1 text-sm text-muted-foreground">Purchase orchestrator — sends LANA orders to this service</p>
            </a>
            <a href="https://direct.lana.fund/docs/api" target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-border p-4 hover:border-primary transition">
              <h3 className="font-semibold text-foreground">Direct.Fund</h3>
              <p className="mt-1 text-sm text-muted-foreground">Investor budgets and FIAT payments</p>
            </a>
          </div>
        </Section>

      {/* Footer */}
      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        <p className="text-xl font-display font-bold text-primary mb-2">
          <span>Lana<span className="text-gold">.Discount</span></span>
        </p>
        <p>© {new Date().getFullYear()} Lana.Discount — Supporting sustainable commerce.</p>
      </footer>
    </div>
  );
};

// --- Helper Components ---

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-12">
    <h2 className="text-2xl font-bold text-foreground mb-4 pb-2 border-b border-border">{title}</h2>
    <div className="text-foreground/80 leading-relaxed">{children}</div>
  </section>
);

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="bg-muted/50 text-foreground font-mono text-sm px-1.5 py-0.5 rounded border border-border/50">{children}</code>
);

const CodeBlock = ({ children }: { children: string }) => (
  <pre className="mt-3 bg-muted/30 border border-border rounded-lg p-4 text-sm font-mono overflow-x-auto text-foreground/80 whitespace-pre-wrap">
    {children}
  </pre>
);

const ParamRow = ({ name, type, required, description }: { name: string; type: string; required?: boolean; description: string }) => (
  <tr>
    <td className="px-4 py-2 font-mono text-sm font-medium text-foreground">{name}</td>
    <td className="px-4 py-2 font-mono text-sm text-muted-foreground">{type}</td>
    <td className="px-4 py-2 text-center">
      {required ? (
        <span className="text-red-500 font-bold text-xs">Yes</span>
      ) : (
        <span className="text-muted-foreground text-xs">No</span>
      )}
    </td>
    <td className="px-4 py-2 text-sm text-muted-foreground">{description}</td>
  </tr>
);

const StatusStep = ({ label, color, description }: { label: string; color: string; description: string }) => {
  const colorMap: Record<string, string> = {
    orange: 'bg-orange-100 text-orange-700 border-orange-200',
    green: 'bg-green-100 text-green-700 border-green-200',
    emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    red: 'bg-red-100 text-red-700 border-red-200',
  };
  return (
    <div className="flex flex-col items-center">
      <span className={`inline-flex items-center px-3 py-1 rounded-lg border text-xs font-bold font-mono ${colorMap[color]}`}>
        {label}
      </span>
      {description && <span className="text-[10px] text-muted-foreground mt-1 text-center max-w-32">{description}</span>}
    </div>
  );
};

const Arrow = () => (
  <svg className="h-4 w-6 text-muted-foreground flex-shrink-0 mx-1 hidden sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
  </svg>
);

export default ApiDocs;
