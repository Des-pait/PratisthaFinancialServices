import express from 'express';
import path from 'path';
import nodemailer from 'nodemailer';
import { addLoanClient } from './googlesheet.js';
import { addContactClient } from './contactSheet.js';
import { fileURLToPath } from 'url';
import crypto from "crypto";

import 'dotenv/config';

const app = express();
const port = process.env.PORT || 8000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====================================================================================
// SECURITY: Input Validation & Sanitization
// ====================================================================================
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return '';
  // Remove potential XSS and SQL injection patterns
  return input
    .trim()
    .replace(/[<>]/g, '') // Remove HTML tags
    .replace(/['";]/g, '') // Remove quotes and semicolons
    .substring(0, 500); // Limit length
};

const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const isValidPhone = (phone) => {
  // Indian phone number validation (10 digits starting with 6-9)
  const phoneRegex = /^[6-9]\d{9}$/;
  return phoneRegex.test(phone.replace(/\s+/g, ''));
};

const isValidAge = (age) => {
  const ageNum = parseInt(age);
  return !isNaN(ageNum) && ageNum >= 18 && ageNum <= 100;
};

const isValidAmount = (amount) => {
  const amountNum = parseFloat(amount);
  return !isNaN(amountNum) && amountNum > 0 && amountNum <= 10000000000;
};

const isValidTenure = (tenure) => {
  const tenureNum = parseInt(tenure);
  return !isNaN(tenureNum) && tenureNum >= 1 && tenureNum <= 30;
};

// ====================================================================================
// CONCURRENT REQUEST HANDLING - OTP Store with automatic cleanup
// ====================================================================================
class OTPStore {
  constructor() {
    this.store = new Map();
    this.maxAttempts = 5; // Maximum verification attempts
    this.cleanupInterval = null;
    this.startAutoCleanup();
  }

  set(email, data) {
    // Normalize email (lowercase, trimmed)
    const normalizedEmail = email.toLowerCase().trim();

    this.store.set(normalizedEmail, {
      ...data,
      timestamp: Date.now(),
      attempts: 0 // Track failed attempts
    });
  }

  get(email) {
    const normalizedEmail = email.toLowerCase().trim();
    const data = this.store.get(normalizedEmail);

    if (!data) return null;

    // Check if expired
    if (Date.now() > data.expiryTime) {
      this.delete(normalizedEmail);
      return null;
    }

    // Check if too many failed attempts
    if (data.attempts >= this.maxAttempts) {
      this.delete(normalizedEmail);
      return null;
    }

    return data;
  }

  incrementAttempts(email) {
    const normalizedEmail = email.toLowerCase().trim();
    const data = this.store.get(normalizedEmail);

    if (data) {
      data.attempts = (data.attempts || 0) + 1;
      this.store.set(normalizedEmail, data);
      return data.attempts;
    }
    return 0;
  }

  delete(email) {
    const normalizedEmail = email.toLowerCase().trim();
    return this.store.delete(normalizedEmail);
  }
  startAutoCleanup() {
    if (process.env.VERCEL) return; 

    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [email, data] of this.store.entries()) {
        if (now > data.expiryTime) {
          this.store.delete(email);
        }
      }
    }, 5 * 60 * 1000);
  }


  stopAutoCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  getStats() {
    const now = Date.now();
    let active = 0;
    let expired = 0;

    for (const [email, data] of this.store.entries()) {
      if (now > data.expiryTime) {
        expired++;
      } else {
        active++;
      }
    }

    return { total: this.store.size, active, expired };
  }
}

const otpStore = new OTPStore();

// ====================================================================================
// EMAIL QUEUE - For handling concurrent email requests
// ====================================================================================
class EmailQueue {
  constructor(concurrency = 3) {
    this.queue = [];
    this.processing = 0;
    this.concurrency = concurrency;
    this.stats = {
      sent: 0,
      failed: 0,
      queued: 0
    };
  }

  async add(emailFunction, priority = 'normal') {
    return new Promise((resolve, reject) => {
      const task = {
        emailFunction,
        priority,
        resolve,
        reject,
        timestamp: Date.now(),
        timeout: setTimeout(() => {
          reject(new Error('Email task timeout'));
        }, 30000) // 30 second timeout
      };

      if (priority === 'high') {
        this.queue.unshift(task);
      } else {
        this.queue.push(task);
      }

      this.stats.queued++;
      this.process();
    });
  }

  async process() {
    if (this.processing >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.processing++;
    const task = this.queue.shift();

    try {
      const result = await task.emailFunction();
      clearTimeout(task.timeout);
      this.stats.sent++;
      this.stats.queued--;
      task.resolve(result);
    } catch (error) {
      clearTimeout(task.timeout);
      this.stats.failed++;
      this.stats.queued--;
      console.error('Email sending failed:', error);
      task.reject(error);
    } finally {
      this.processing--;
      this.process();
    }
  }

  getStats() {
    return {
      ...this.stats,
      processing: this.processing,
      pending: this.queue.length
    };
  }
}

const emailQueue = new EmailQueue(
  process.env.VERCEL ? 1 : 3
);

// ====================================================================================
// EMAIL CONFIGURATION - Singleton transporter with connection pooling
// ====================================================================================
let emailTransporter = null;

const getEmailTransporter = () => {
  if (!emailTransporter) {
    emailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD,
      },
      pool: true,
      maxConnections: 3,
      maxMessages: 10,
      rateDelta: 1000,
      rateLimit: 3,
      connectionTimeout: 10000,
      greetingTimeout: 5000,
    });

    emailTransporter.verify((error, success) => {
      if (error) {
        console.error("❌ Email transporter verification failed:", error);
      } else {
        console.log("✅ Email transporter is ready to send emails");
      }
    });
  }

  return emailTransporter;
};

// ====================================================================================
// UTILITY FUNCTIONS
// ====================================================================================

// SECURITY: Generate cryptographically secure OTP
const generateOTP = () => {
  // Use crypto for secure random generation
  const buffer = crypto.randomBytes(3);
  const otp = parseInt(buffer.toString('hex'), 16) % 900000 + 100000;
  return otp.toString();
};

// ====================================================================================
// SECURITY: Enhanced Rate Limiting
// ====================================================================================
class RateLimiter {
  constructor(maxRequests = 3, windowMs = 60000) {
    this.requests = new Map();
    this.blockedIPs = new Map(); // Track blocked IPs
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.blockDuration = 5 * 60 * 1000; // 5 minutes block
  }

  isAllowed(identifier) {
    // Check if blocked
    const blocked = this.blockedIPs.get(identifier);
    if (blocked && Date.now() < blocked) {
      return false;
    } else if (blocked) {
      this.blockedIPs.delete(identifier);
    }

    const now = Date.now();
    const userRequests = this.requests.get(identifier) || [];

    const recentRequests = userRequests.filter(
      timestamp => now - timestamp < this.windowMs
    );

    if (recentRequests.length >= this.maxRequests) {
      // Block this identifier
      this.blockedIPs.set(identifier, now + this.blockDuration);
      return false;
    }

    recentRequests.push(now);
    this.requests.set(identifier, recentRequests);

    if (Math.random() < 0.1) {
      this.cleanup();
    }

    return true;
  }

  cleanup() {
    const now = Date.now();

    for (const [identifier, timestamps] of this.requests.entries()) {
      const recent = timestamps.filter(
        timestamp => now - timestamp < this.windowMs
      );
      if (recent.length === 0) {
        this.requests.delete(identifier);
      } else {
        this.requests.set(identifier, recent);
      }
    }

    for (const [ip, blockUntil] of this.blockedIPs.entries()) {
      if (now >= blockUntil) {
        this.blockedIPs.delete(ip);
      }
    }
  }
}

const otpRateLimiter = new RateLimiter(3, 60000); // 3 OTP per minute

// ====================================================================================
// EMAIL SENDING FUNCTIONS (Optimized for queue)
// ====================================================================================

const sendOTPEmail = async (email, otp, type = 'contact') => {
  const transporter = getEmailTransporter();
  const formType = type === 'contact' ? 'Contact Form' : 'Loan Application';

  const mailOptions = {
    from: `"Pratistha Business & Finance Solutions" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: `Email Verification - ${formType}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 30px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 40px 30px; }
            .otp-box { background: linear-gradient(135deg, #ecfdf5, #d1fae5); border: 3px solid #059669; padding: 30px; text-align: center; border-radius: 15px; margin: 30px 0; }
            .otp-code { font-size: 12px; font-weight: bold; color: #047857; letter-spacing: 8px; font-family: monospace; margin: 10px 0; }
            .warning-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 5px; }
            .footer { background: #1f2937; color: #9ca3af; padding: 20px; text-align: center; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Email Verification</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">Pratistha Business & Finance Solutions</p>
            </div>
            
            <div class="content">
              <h2 style="color: #059669; margin-top: 0;">Verify Your Email Address</h2>
              
              <p>Thank you for submitting the <strong>${formType}</strong>. Please verify your email using the OTP below.</p>

              <div class="otp-box">
                <p style="margin: 0 0 10px 0; color: #047857; font-weight: 600;">Your Verification Code</p>
                <div class="otp-code">${otp}</div>
              </div>

              <div class="warning-box">
                <strong>Important:</strong>
                <ul style="margin: 10px 0 0 0; padding-left: 20px;">
                  <li>This OTP is valid for <strong>10 minutes</strong></li>
                  <li>Do not share this code with anyone</li>
                  <li>Maximum 5 verification attempts allowed</li>
                </ul>
              </div>
            </div>
            
            <div class="footer">
              <p style="margin: 0;">© ${new Date().getFullYear()} Pratistha Business & Finance Solutions. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
    text: `Email Verification - Pratistha Business & Finance Solutions\n\nYour OTP Code: ${otp}\n\nThis OTP is valid for 10 minutes. Do not share this code with anyone.`
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`✅ OTP email sent to ${email.substring(0, 3)}***`);
  return { success: true, messageId: info.messageId };
};

const sendContactEmail = async (contactData) => {
  const transporter = getEmailTransporter();
  const businessEmail = process.env.BUSINESS_EMAIL || process.env.EMAIL_USER;

  const mailOptions = {
    from: `"Pratistha Business & Finance Solutions" <${process.env.EMAIL_USER}>`,
    to: contactData.email,
    subject: `Contact Request Received - ${contactData.name}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 30px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 30px; }
            .info-section { background: #f9fafb; border-left: 4px solid #059669; padding: 15px; margin: 15px 0; border-radius: 5px; }
            .info-row { display: flex; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
            .info-row:last-child { border-bottom: none; }
            .label { font-weight: bold; color: #059669; min-width: 150px; }
            .value { color: #4b5563; }
            .message-box { background: #ecfdf5; border: 1px solid #d1fae5; padding: 20px; border-radius: 8px; margin-top: 20px; }
            .message-box h3 { color: #059669; margin-top: 0; }
            .footer { background: #1f2937; color: #9ca3af; padding: 20px; text-align: center; font-size: 12px; }
            .priority-high { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin-bottom: 20px; border-radius: 5px; }
            .verified-badge { background: #10b981; color: white; padding: 5px 15px; border-radius: 20px; font-size: 12px; font-weight: bold; display: inline-block; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📧 New Contact Form Submission</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">Pratistha Business & Finance Solutions</p>
            </div>
            
            <div class="content">
              <div class="priority-high">
                <strong>Details Received:</strong> New contact inquiry received. We will get back to you within 24 working hours.
              </div>

              <p style="margin-bottom: 20px;">
                <span class="verified-badge">✓ EMAIL VERIFIED</span>
              </p>

              <div class="info-section">
                <h3 style="color: #059669; margin-top: 0;">👤 Contact Information</h3>
                
                <div class="info-row">
                  <span class="label">Full Name:</span>
                  <span class="value">${contactData.name || 'Not provided'}</span>
                </div>
                
                <div class="info-row">
                  <span class="label">Email Address:</span>
                  <span class="value"><a href="mailto:${contactData.email}" style="color: #059669;">${contactData.email || 'Not provided'}</a></span>
                </div>
                
                <div class="info-row">
                  <span class="label">Phone Number:</span>
                  <span class="value"><a href="tel:${contactData.phone}" style="color: #059669;">${contactData.phone || 'Not provided'}</a></span>
                </div>
                
                <div class="info-row">
                  <span class="label">State & Pincode:</span>
                  <span class="value">${contactData.state || 'Not provided'}</span>
                </div>
                
                <div class="info-row">
                  <span class="label">District:</span>
                  <span class="value">${contactData.district || 'Not provided'}</span>
                </div>
              </div>

              ${contactData.require || contactData.message ? `
              <div class="message-box">
                <h3>💬 Message/Requirement</h3>
                <p style="margin: 10px 0 0 0; white-space: pre-wrap;">${contactData.require || contactData.message}</p>
              </div>
              ` : ''}

              <div style="margin-top: 30px; padding: 15px; background: #f9fafb; border-radius: 8px;">
                <p style="margin: 0; font-size: 14px; color: #6b7280;">
                  <strong>Submitted on:</strong> ${new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'full',
      timeStyle: 'short'
    })}
                </p>
              </div>
            </div>
            
            <div class="footer">
              <p style="margin: 0;">This email was sent from the Pratistha Business & Finance Solutions contact form.</p>
              <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Pratistha Business & Finance Solutions. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `
  };

  const contactId = `CT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const info = await transporter.sendMail(mailOptions);
  await addContactClient(contactData, contactId)
    .catch(err => console.error('❌ Contact sheet error:', err));

  return { success: true, messageId: info.messageId };
};

const sendLoanApplicationEmail = async (applicationData) => {
  const transporter = getEmailTransporter();
  const calculateEMI = (principal, tenure) => {
    const rate = 10;
    const monthlyRate = rate / 12 / 100;
    const months = tenure * 12;
    const emi = (principal * monthlyRate * Math.pow(1 + monthlyRate, months)) /
      (Math.pow(1 + monthlyRate, months) - 1);
    return emi.toFixed(2);
  };

  const estimatedEMI = applicationData.loan_amount && applicationData.tenure
    ? calculateEMI(applicationData.loan_amount, applicationData.tenure)
    : 'N/A';

  const mailOptions = {
    from: `"Pratistha Business & Finance Solutions" <${process.env.EMAIL_USER}>`,
    to: applicationData.email,
    subject: `Your Loan Application - ${applicationData.loan || 'Loan'} - ${applicationData.name}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 700px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 30px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 30px; }
            .alert-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin-bottom: 25px; border-radius: 5px; }
            .section { background: #f9fafb; border-left: 4px solid #059669; padding: 20px; margin: 20px 0; border-radius: 5px; }
            .section h3 { color: #059669; margin: 0 0 15px 0; font-size: 12px; }
            .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
            .info-item { padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
            .info-label { font-weight: bold; color: #059669; font-size: 13px; display: block; margin-bottom: 5px; }
            .info-value { color: #1f2937; font-size: 12px; }
            .highlight-box { background: linear-gradient(135deg, #ecfdf5, #d1fae5); border: 2px solid #059669; padding: 20px; border-radius: 8px; margin: 20px 0; }
            .loan-details { display: flex; justify-content: space-around; text-align: center; }
            .loan-detail-item { flex: 1; }
            .loan-detail-value { font-size: 14px; font-weight: bold; color: #059669; display: block; }
            .loan-detail-label { font-size: 12px; color: #6b7280; display: block; margin-top: 5px; }
            .footer { background: #1f2937; color: #9ca3af; padding: 20px; text-align: center; font-size: 12px; }
            .verified-badge { background: #10b981; color: white; padding: 5px 15px; border-radius: 20px; font-size: 12px; font-weight: bold; display: inline-block; margin-bottom: 20px; }
            @media only screen and (max-width: 600px) {
              .info-grid { grid-template-columns: 1fr; }
              .loan-details { flex-direction: column; }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>💰 We Have Received Your Loan Application</h1>
              <p>Pratistha Business & Finance Solutions</p>
            </div>
            
            <div class="content">
              <div class="alert-box">
                <strong>⚡ Priority Application:</strong> We will review your application and contact you within 24-48 working hours.
              </div>

              <span class="verified-badge">✓ EMAIL VERIFIED</span>

              <div class="highlight-box">
                <h3>📊 Application Summary</h3>
                <div class="loan-details">
                  <div class="loan-detail-item">
                    <span class="loan-detail-value">₹${applicationData.loan_amount ? Number(applicationData.loan_amount).toLocaleString('en-IN') : 'N/A'}</span>
                    <span class="loan-detail-label">Loan Amount</span>
                  </div>
                  <div class="loan-detail-item">
                    <span class="loan-detail-value">${applicationData.tenure || 'N/A'} Years</span>
                    <span class="loan-detail-label">Tenure</span>
                  </div>
                  <div class="loan-detail-item">
                    <span class="loan-detail-value">₹${estimatedEMI !== 'N/A' ? Number(estimatedEMI).toLocaleString('en-IN') : 'N/A'}</span>
                    <span class="loan-detail-label">Est. Monthly EMI</span>
                  </div>
                </div>
              </div>

              <div class="section">
                <h3>👤 Personal Information</h3>
                <div class="info-grid">
                  <div class="info-item">
                    <span class="info-label">Full Name</span>
                    <span class="info-value">${applicationData.name || 'Not provided'}</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Age</span>
                    <span class="info-value">${applicationData.age || 'Not provided'} years</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Employment Type</span>
                    <span class="info-value">${applicationData.employement || 'Not provided'}</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Position/Designation</span>
                    <span class="info-value">${applicationData.position || 'Not provided'}</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">State & Pincode</span>
                    <span class="info-value">${applicationData.state || 'Not provided'}</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">District</span>
                    <span class="info-value">${applicationData.district || 'Not provided'}</span>
                  </div>
                </div>
              </div>

              <div class="section">
                <h3>💼 Loan Requirements</h3>
                <div class="info-grid">
                  <div class="info-item">
                    <span class="info-label">Type of Loan</span>
                    <span class="info-value">${applicationData.loan || 'Not provided'}</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Monthly Income</span>
                    <span class="info-value">₹${applicationData.income ? Number(applicationData.income).toLocaleString('en-IN') : 'Not provided'}</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Loan Amount Required</span>
                    <span class="info-value">₹${applicationData.loan_amount ? Number(applicationData.loan_amount).toLocaleString('en-IN') : 'Not provided'}</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Loan Tenure</span>
                    <span class="info-value">${applicationData.tenure || 'Not provided'} years</span>
                  </div>
                </div>
              </div>

              <div class="section">
                <h3>📞 Contact Information</h3>
                <div class="info-grid">
                  <div class="info-item">
                    <span class="info-label">Mobile Number</span>
                    <span class="info-value"><a href="tel:${applicationData.phone}" style="color: #059669;">${applicationData.phone || 'Not provided'}</a></span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Email Address</span>
                    <span class="info-value"><a href="mailto:${applicationData.email}" style="color: #059669;">${applicationData.email || 'Not provided'}</a></span>
                  </div>
                </div>
              </div>

              <div style="margin-top: 30px; padding: 15px; background: #f9fafb; border-radius: 8px;">
                <p style="margin: 0; font-size: 14px; color: #6b7280;">
                  <strong>Application Submitted:</strong> ${new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'full',
      timeStyle: 'short'
    })}
                </p>
                <p style="margin: 10px 0 0 0; font-size: 14px; color: #6b7280;">
                  <strong>Application ID:</strong> LA-${Date.now()}
                </p>
              </div>
            </div>
            
            <div class="footer">
              <p style="margin: 0;">This email was sent from the Pratistha Business & Finance Solutions loan application system.</p>
              <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Pratistha Business & Finance Solutions. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `
  };

  const applicationId = `LA-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const info = await transporter.sendMail(mailOptions);
  await addLoanClient(applicationData, applicationId)
    .catch(err => console.error('❌ Loan sheet error:', err));

  return { success: true, messageId: info.messageId };
};

// ====================================================================================
// MIDDLEWARE
// ====================================================================================

// Serve static files
app.use(express.static('views', {
  setHeaders: (res, path, stat) => {
    if (path.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html');
    } else if (path.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    } else if (path.endsWith('.js')) {
      res.setHeader('Content-Type', 'text/javascript');
    } else if (path.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/jpeg');
    } else if (path.endsWith('.gif')) {
      res.setHeader('Content-Type', 'image/gif');
    }
  }
}));

// app.use('/static', express.static('static'));

// SECURITY: Add body size limits
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));

// app.use('/uploads', express.static('uploads'));

app.set('view engine', 'pug');
app.set('views', path.join(__dirname, '../views'));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

// ====================================================================================
// ROUTES - Page Rendering
// ====================================================================================

app.get('/', (req, res) => {
  const params = { 'title': 'welcome !!' }
  res.status(200).render('index.pug', params);
});

app.get('/applyloan', (req, res) => {
  const params = {}
  res.status(200).render('apply.pug', params);
});

app.get('/contact', (req, res) => {
  const params = {}
  res.status(200).render('contact.pug');
});

app.get('/services', (req, res) => {
  const params = {}
  res.status(200).render('services.pug');
});

app.get('/EMI', (req, res) => {
  const params = {}
  res.status(200).render('services.pug');
});

app.get('/about', (req, res) => {
  const params = {}
  res.status(200).render('about.pug');
});

// ====================================================================================
// API ENDPOINTS - OTP Management
// ====================================================================================

// Send OTP for contact form
app.post('/api/send-otp-contact', async (req, res) => {
  try {
    const { email } = req.body;

    // SECURITY: Comprehensive validation
    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Valid email is required'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    // SECURITY: Rate limiting with IP blocking
    const clientIP = req.ip || req.connection.remoteAddress;
    const rateLimitKey = `${clientIP}-${email}`;

    if (!otpRateLimiter.isAllowed(rateLimitKey)) {
      return res.status(429).json({
        success: false,
        message: 'Too many OTP requests. Please try again after 1 minute.'
      });
    }

    const otp = generateOTP();
    const expiryTime = Date.now() + 10 * 60 * 1000;

    otpStore.set(email, {
      otp,
      expiryTime,
      type: 'contact'
    });

    emailQueue.add(
      () => sendOTPEmail(email, otp, 'contact'),
      'high'
    ).catch(error => {
      console.error('❌ Failed to queue OTP email:', error);
    });

    console.log(`📧 OTP queued for contact form`);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your email'
    });

  } catch (error) {
    console.error('❌ Error in send-otp-contact:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP. Please try again.'
    });
  }
});

// Send OTP for loan application
app.post('/api/send-otp-apply', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Valid email is required'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const clientIP = req.ip || req.connection.remoteAddress;
    const rateLimitKey = `${clientIP}-${email}`;

    if (!otpRateLimiter.isAllowed(rateLimitKey)) {
      return res.status(429).json({
        success: false,
        message: 'Too many OTP requests. Please try again after 1 minute.'
      });
    }

    const otp = generateOTP();
    const expiryTime = Date.now() + 10 * 60 * 1000;

    otpStore.set(email, {
      otp,
      expiryTime,
      type: 'apply'
    });

    emailQueue.add(
      () => sendOTPEmail(email, otp, 'apply'),
      'high'
    ).catch(error => {
      console.error('❌ Failed to queue OTP email:', error);
    });

    console.log(`📧 OTP queued for loan application`);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your email'
    });

  } catch (error) {
    console.error('❌ Error in send-otp-apply:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP. Please try again.'
    });
  }
});

// ====================================================================================
// API ENDPOINTS - Form Submission
// ====================================================================================

// Verify OTP and submit contact form
app.post('/contact', async (req, res) => {
  try {
    const { email, otp, name, phone, state, district, require: requirement } = req.body;

    // SECURITY: Validate all inputs
    if (!email || !otp || !name || !phone || !state || !district) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format'
      });
    }

    // Verify OTP
    const storedData = otpStore.get(email);

    if (!storedData) {
      return res.status(400).json({
        success: false,
        message: 'OTP not found or expired. Please request a new OTP.'
      });
    }

    if (storedData.otp !== otp.trim()) {
      const attempts = otpStore.incrementAttempts(email);
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please try again.',
        attemptsRemaining: 5 - attempts
      });
    }

    // OTP verified - delete it
    otpStore.delete(email);

    // SECURITY: Sanitize all inputs
    const contactData = {
      name: sanitizeInput(name),
      email: email,
      phone: sanitizeInput(phone),
      state: sanitizeInput(state),
      district: sanitizeInput(district),
      require: requirement ? sanitizeInput(requirement) : ''
    };

    emailQueue.add(
      () => sendContactEmail(contactData),
      'normal'
    ).catch(error => {
      console.error('❌ Failed to queue contact email:', error);
    });

    console.log('✅ Contact form verified and queued');

    res.status(200).json({
      success: true,
      message: 'Thank you for contacting us! We will get back to you within 24-48 hours.'
    });

  } catch (error) {
    console.error('❌ Contact form error:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred. Please try again.'
    });
  }
});

// Verify OTP and submit loan application
app.post('/apply', async (req, res) => {
  try {
    const {
      email, otp, name, age, employement, position, state, district,
      loan, income, loan_amount, tenure, phone
    } = req.body;

    // SECURITY: Comprehensive validation
    if (!email || !otp || !name || !age || !phone || !loan || !income || !loan_amount || !tenure) {
      return res.status(400).json({
        success: false,
        message: 'All required fields must be provided'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number'
      });
    }

    if (!isValidAge(age)) {
      return res.status(400).json({
        success: false,
        message: 'Age must be between 18 and 100'
      });
    }

    if (!isValidAmount(loan_amount)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid loan amount'
      });
    }

    if (!isValidAmount(income)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid income amount'
      });
    }

    if (!isValidTenure(tenure)) {
      return res.status(400).json({
        success: false,
        message: 'Tenure must be between 1 and 30 years'
      });
    }

    // Verify OTP
    const storedData = otpStore.get(email);

    if (!storedData) {
      return res.status(400).json({
        success: false,
        message: 'OTP not found or expired. Please request a new OTP.'
      });
    }

    if (storedData.otp !== otp.trim()) {
      const attempts = otpStore.incrementAttempts(email);
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please try again.',
        attemptsRemaining: 5 - attempts
      });
    }

    // OTP verified - delete it
    otpStore.delete(email);

    // SECURITY: Sanitize all inputs
    const applicationData = {
      name: sanitizeInput(name),
      age: sanitizeInput(age),
      employement: sanitizeInput(employement),
      position: sanitizeInput(position),
      state: sanitizeInput(state),
      district: sanitizeInput(district),
      loan: sanitizeInput(loan),
      income: sanitizeInput(income),
      loan_amount: sanitizeInput(loan_amount),
      tenure: sanitizeInput(tenure),
      phone: sanitizeInput(phone),
      email: email
    };

    const applicationId = `LA-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    emailQueue.add(
      () => sendLoanApplicationEmail(applicationData),
      'normal'
    ).catch(error => {
      console.error('❌ Failed to queue loan email:', error);
    });

    console.log('✅ Loan application verified and queued');

    res.status(200).json({
      success: true,
      message: 'Your loan application has been submitted successfully! We will contact you within 24-48 hours.',
      applicationId
    });

  } catch (error) {
    console.error('❌ Loan application error:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred. Please try again.'
    });
  }
});

// ====================================================================================
// MONITORING ENDPOINTS
// ====================================================================================

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
    },
    otpStore: otpStore.getStats(),
    emailQueue: emailQueue.getStats()
  });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  res.status(200).json({
    otpStore: otpStore.getStats(),
    emailQueue: emailQueue.getStats()
  });
});

// ====================================================================================
// ERROR HANDLING
// ====================================================================================

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Global error handler:', err);

  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(500).json({
    success: false,
    message
  });
});

// ====================================================================================
// SERVER STARTUP & GRACEFUL SHUTDOWN
// ====================================================================================

// Graceful shutdown
const gracefulShutdown = () => {
  console.log('\n🛑 Shutting down gracefully...');

  otpStore.stopAutoCleanup();

  if (emailTransporter) {
    emailTransporter.close();
  }

  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// SECURITY: Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server (only if not in Vercel environment)
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`\n🚀 Server started successfully!`);
    console.log(`📍 Server running on: http://localhost:${port}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📧 Email configured: ${process.env.EMAIL_USER ? '✅' : '❌'}`);
    console.log(`\n📊 Monitoring endpoints:`);
    console.log(`   Health: http://localhost:${port}/api/health`);
    console.log(`   Stats: http://localhost:${port}/api/stats`);
  });
}

// Export for Vercel
export default app;