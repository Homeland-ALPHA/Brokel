import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import prisma from './prisma.js';
import { stripe } from './stripe.js';
import authenticate from './middleware/auth.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TTL_SECONDS = parseInt(process.env.JWT_ACCESS_TTL_SECONDS ?? '900', 10);
const REFRESH_TTL_DAYS = parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '30', 10);

const ACCESS_EXPIRY = Number.isFinite(ACCESS_TTL_SECONDS) && ACCESS_TTL_SECONDS > 0 ? ACCESS_TTL_SECONDS : 900;
const REFRESH_EXPIRY_MS = (Number.isFinite(REFRESH_TTL_DAYS) && REFRESH_TTL_DAYS > 0 ? REFRESH_TTL_DAYS : 30) * 24 * 60 * 60 * 1000;

const sanitizeUser = (user) => {
  if (!user) return null;
  const {
    passwordHash,
    sessions,
    ...safe
  } = user;
  return safe;
};

const issueAccessToken = (userId) => {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: `${ACCESS_EXPIRY}s` });
};

const createSession = async (userId, userAgent) => {
  const refreshToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRY_MS);

  const session = await prisma.session.create({
    data: {
      userId,
      refreshToken,
      userAgent: userAgent?.slice(0, 255) ?? null,
      expiresAt,
    },
  });

  return { refreshToken: session.refreshToken, expiresAt };
};

const generateTokens = async (user, userAgent) => {
  const accessToken = issueAccessToken(user.id);
  const session = await createSession(user.id, userAgent);
  return {
    accessToken,
    accessTokenExpiresIn: ACCESS_EXPIRY,
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.expiresAt,
  };
};

router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body ?? {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required.' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    let stripeCustomerId = undefined;
    if (stripe) {
      try {
        const customer = await stripe.customers.create({
          email: email.toLowerCase(),
          name: fullName || undefined,
        });
        stripeCustomerId = customer.id;
      } catch (error) {
        console.error('stripe.customers.create failed during registration', error.message);
      }
    }

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        fullName: fullName || null,
        stripeCustomerId,
      },
    });

    const tokens = await generateTokens(user, req.headers['user-agent']);

    return res.status(201).json({
      user: sanitizeUser(user),
      tokens,
    });
  } catch (error) {
    console.error('POST /api/auth/register failed', error);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const tokens = await generateTokens(user, req.headers['user-agent']);

    return res.json({
      user: sanitizeUser(user),
      tokens,
    });
  } catch (error) {
    console.error('POST /api/auth/login failed', error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'Refresh token is required.' });
    }

    const session = await prisma.session.findUnique({ where: { refreshToken } });
    if (!session) {
      return res.status(401).json({ error: 'Invalid refresh token.' });
    }

    if (session.expiresAt <= new Date()) {
      await prisma.session.delete({ where: { id: session.id } });
      return res.status(401).json({ error: 'Refresh token has expired.' });
    }

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) {
      await prisma.session.delete({ where: { id: session.id } });
      return res.status(401).json({ error: 'User associated with token no longer exists.' });
    }

    await prisma.session.delete({ where: { id: session.id } });
    const tokens = await generateTokens(user, req.headers['user-agent']);

    return res.json({
      user: sanitizeUser(user),
      tokens,
    });
  } catch (error) {
    console.error('POST /api/auth/refresh failed', error);
    res.status(500).json({ error: 'Failed to refresh tokens.' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'Refresh token is required.' });
    }
    await prisma.session.deleteMany({ where: { refreshToken } });
    res.json({ success: true });
  } catch (error) {
    console.error('POST /api/auth/logout failed', error);
    res.status(500).json({ error: 'Logout failed.' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

export default router;
