import { Hono } from 'hono';
import { db } from '../db/index.js';
import { subscriptions, plans } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';

const router = new Hono();

const STRIPE_ENABLED = !!process.env.STRIPE_SECRET_KEY;

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2026-06-24.dahlia' });
}

async function getUserSubscription(userId: string) {
  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.user_id, userId),
  });
  if (sub) return sub;
  const [created] = await db.insert(subscriptions).values({
    user_id: userId,
    plan_id: 'free',
    status: 'active',
  }).returning();
  return created;
}

router.get('/plan', async (c) => {
  const userId = c.req.header('x-user-id') ?? 'anonymous';
  const sub = await getUserSubscription(userId);
  const plan = await db.query.plans.findFirst({ where: eq(plans.id, sub.plan_id) });
  return c.json({ subscription: sub, plan, stripeEnabled: STRIPE_ENABLED });
});

router.post('/checkout', async (c) => {
  const userId = c.req.header('x-user-id') ?? 'anonymous';
  const stripe = getStripe();
  if (!stripe) return c.json({ error: 'Billing not configured' }, 503);
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) return c.json({ error: 'STRIPE_PRO_PRICE_ID not configured' }, 503);
  const sub = await getUserSubscription(userId);
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${frontendUrl}/dashboard/settings?upgraded=1`,
    cancel_url: `${frontendUrl}/pricing`,
    metadata: { user_id: userId },
  };
  if (sub.stripe_customer_id) sessionParams.customer = sub.stripe_customer_id;
  const session = await stripe.checkout.sessions.create(sessionParams);
  return c.json({ url: session.url });
});

router.post('/portal', async (c) => {
  const userId = c.req.header('x-user-id') ?? 'anonymous';
  const stripe = getStripe();
  if (!stripe) return c.json({ error: 'Billing not configured' }, 503);
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
  const sub = await getUserSubscription(userId);
  if (!sub.stripe_customer_id) return c.json({ error: 'No billing account found' }, 400);
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${frontendUrl}/dashboard/settings`,
  });
  return c.json({ url: session.url });
});

router.post('/webhook', async (c) => {
  const stripe = getStripe();
  if (!stripe) return c.json({ error: 'Billing not configured' }, 503);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return c.json({ error: 'STRIPE_WEBHOOK_SECRET not set' }, 503);
  const sig = c.req.header('stripe-signature');
  if (!sig) return c.json({ error: 'Missing stripe-signature' }, 400);
  const rawBody = await c.req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Webhook signature verification failed: ${msg}` }, 400);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.user_id;
    if (!userId) return c.json({ received: true });
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;
    let periodEnd: Date | null = null;
    if (subscriptionId) {
      const stripeSub = await stripe.subscriptions.retrieve(subscriptionId) as unknown as { current_period_end: number };
      periodEnd = new Date(stripeSub.current_period_end * 1000);
    }
    const existing = await db.query.subscriptions.findFirst({ where: eq(subscriptions.user_id, userId) });
    if (existing) {
      await db.update(subscriptions).set({
        plan_id: 'pro', stripe_customer_id: customerId, stripe_subscription_id: subscriptionId,
        status: 'active', current_period_end: periodEnd, updated_at: new Date(),
      }).where(eq(subscriptions.user_id, userId));
    } else {
      await db.insert(subscriptions).values({
        user_id: userId, plan_id: 'pro', stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId, status: 'active', current_period_end: periodEnd,
      });
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const stripeSub = event.data.object as Stripe.Subscription;
    const customerId = typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id;
    await db.update(subscriptions).set({
      plan_id: 'free', stripe_subscription_id: null, status: 'canceled',
      current_period_end: null, updated_at: new Date(),
    }).where(eq(subscriptions.stripe_customer_id, customerId));
  }
  return c.json({ received: true });
});

export default router;
