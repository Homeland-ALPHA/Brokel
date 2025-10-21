import express from 'express';

import prisma from './prisma.js';
import authenticate from './middleware/auth.js';
import { stripe } from './stripe.js';

const priceId = process.env.STRIPE_PRICE_ID;
const successUrl =
  process.env.STRIPE_SUCCESS_URL ||
  'http://localhost:5173/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}';
const cancelUrl = process.env.STRIPE_CANCEL_URL || 'http://localhost:5173/dashboard?checkout=canceled';
const portalReturnUrl = process.env.STRIPE_PORTAL_RETURN_URL || successUrl;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const paymentsRouter = express.Router();
paymentsRouter.use(authenticate);

const respondStripeMisconfigured = (res) =>
  res.status(500).json({ error: 'Stripe is not configured for this environment.' });

const ensureStripeCustomer = async (user) => {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.fullName || undefined,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });

  user.stripeCustomerId = customer.id;
  return customer.id;
};

paymentsRouter.post('/checkout-session', async (req, res) => {
  if (!stripe || !priceId) {
    return respondStripeMisconfigured(res);
  }

  try {
    const user = req.user;
    const customerId = await ensureStripeCustomer(user);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
    });

    return res.json({ url: session.url, id: session.id });
  } catch (error) {
    console.error('stripe.checkout.sessions.create failed', error.message);
    return res.status(500).json({ error: 'Unable to create checkout session.' });
  }
});

paymentsRouter.post('/portal-session', async (req, res) => {
  if (!stripe) {
    return respondStripeMisconfigured(res);
  }

  try {
    const user = req.user;
    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No Stripe customer is associated with this account.' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: portalReturnUrl,
    });

    return res.json({ url: portalSession.url });
  } catch (error) {
    console.error('stripe.billingPortal.sessions.create failed', error.message);
    return res.status(500).json({ error: 'Unable to open the billing portal.' });
  }
});

const updateSubscriptionState = async ({ customerId, subscriptionId, status }) => {
  const normalizedCustomerId =
    typeof customerId === 'string'
      ? customerId
      : customerId && typeof customerId === 'object' && 'id' in customerId
      ? customerId.id
      : null;

  if (!normalizedCustomerId) {
    return;
  }

  const planTier = status && ['active', 'trialing'].includes(status) ? 'pro' : 'free';

  const normalizedSubscriptionId =
    typeof subscriptionId === 'string'
      ? subscriptionId
      : subscriptionId && typeof subscriptionId === 'object' && 'id' in subscriptionId
      ? subscriptionId.id
      : null;

  const updateData = {
    subscriptionStatus: status || 'free',
    planTier,
  };

  if (normalizedSubscriptionId !== null && (!status || !['canceled', 'past_due', 'unpaid'].includes(status))) {
    updateData.stripeSubscriptionId = normalizedSubscriptionId;
  } else if (status && ['canceled', 'past_due', 'unpaid'].includes(status)) {
    updateData.stripeSubscriptionId = null;
  }

  await prisma.user.updateMany({
    where: { stripeCustomerId: normalizedCustomerId },
    data: updateData,
  });
};

export const stripeWebhookHandler = async (req, res) => {
  if (!stripe) {
    return res.status(500).send('Stripe is not configured for this environment.');
  }

  let event;

  try {
    if (webhookSecret) {
      const signature = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (error) {
    console.error('Stripe webhook verification failed', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription') {
          await updateSubscriptionState({
            customerId: session.customer,
            subscriptionId: session.subscription,
            status: 'active',
          });
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await updateSubscriptionState({
          customerId: subscription.customer,
          subscriptionId: subscription.id,
          status: subscription.status,
        });
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await updateSubscriptionState({
          customerId: invoice.customer,
          subscriptionId: invoice.subscription,
          status: 'past_due',
        });
        break;
      }
      default:
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (error) {
    console.error('Stripe webhook processing failed', error);
  }

  return res.json({ received: true });
};

export default paymentsRouter;
