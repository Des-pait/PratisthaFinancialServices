const express = require("express");
const path = require("path");
const fs = require("fs");
var mongoose = require("mongoose");
const bodyparser = require("body-parser");
const nodemailer = require("nodemailer");
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8000;

// ====================================================================================
// CONCURRENT REQUEST HANDLING - OTP Store with automatic cleanup
// ====================================================================================
class OTPStore {
  constructor() {
    this.store = new Map();
    this.cleanupInterval = null;
    this.startAutoCleanup();
  }

  // Set OTP with automatic expiry
  set(email, data) {
    this.store.set(email, {
      ...data,
      timestamp: Date.now()
    });
  }

  // Get OTP data
  get(email) {
    const data = this.store.get(email);
    if (!data) return null;

    // Check if expired
    if (Date.now() > data.expiryTime) {
      this.delete(email);
      return null;
    }

    return data;
  }

  // Delete OTP
  delete(email) {
    return this.store.delete(email);
  }

  // Clean up expired OTPs every 5 minutes
  startAutoCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [email, data] of this.store.entries()) {
        if (now > data.expiryTime) {
          this.store.delete(email);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} expired OTPs`);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  // Stop cleanup (for graceful shutdown)
  stopAutoCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  // Get store statistics
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
  constructor(concurrency = 5) {
    this.queue = [];
    this.processing = 0;
    this.concurrency = concurrency;
    this.stats = {
      sent: 0,
      failed: 0,
      queued: 0
    };
  }

  // Add email to queue
  async add(emailFunction, priority = 'normal') {
    return new Promise((resolve, reject) => {
      const task = {
        emailFunction,
        priority,
        resolve,
        reject,
        timestamp: Date.now()
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

  // Process queue
  async process() {
    if (this.processing >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.processing++;
    const task = this.queue.shift();

    try {
      const result = await task.emailFunction();
      this.stats.sent++;
      this.stats.queued--;
      task.resolve(result);
    } catch (error) {
      this.stats.failed++;
      this.stats.queued--;
      task.reject(error);
    } finally {
      this.processing--;
      this.process(); // Process next item
    }
  }

  // Get queue statistics
  getStats() {
    return {
      ...this.stats,
      processing: this.processing,
      pending: this.queue.length
    };
  }
}

const emailQueue = new EmailQueue(5); // Process up to 5 emails concurrently

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

      // Pooling & throttling (good for OTP systems)
      pool: true,
      maxConnections: 5,
      maxMessages: 10,
      rateDelta: 1000,
      rateLimit: 5,
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

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Validate email format
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Rate limiting helper (simple in-memory implementation)
class RateLimiter {
  constructor(maxRequests = 10, windowMs = 60000) {
    this.requests = new Map();
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  isAllowed(identifier) {
    const now = Date.now();
    const userRequests = this.requests.get(identifier) || [];

    // Filter out old requests
    const recentRequests = userRequests.filter(
      timestamp => now - timestamp < this.windowMs
    );

    if (recentRequests.length >= this.maxRequests) {
      return false;
    }

    recentRequests.push(now);
    this.requests.set(identifier, recentRequests);

    // Cleanup old entries periodically
    if (Math.random() < 0.01) {
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
  }
}

const otpRateLimiter = new RateLimiter(5, 60000); // 5 OTP requests per minute per email

// ====================================================================================
// EMAIL SENDING FUNCTIONS (Optimized for queue)
// ====================================================================================

const sendOTPEmail = async (email, otp, type = 'contact') => {
  const transporter = getEmailTransporter();
  const formType = type === 'contact' ? 'Contact Form' : 'Loan Application';

  const mailOptions = {
    from: `"Pratistha Financial Services" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: `Email Verification - ${formType} - OTP: ${otp}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 30px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; }
            .content { padding: 40px 30px; }
            .otp-box { background: linear-gradient(135deg, #ecfdf5, #d1fae5); border: 3px solid #059669; padding: 30px; text-align: center; border-radius: 15px; margin: 30px 0; }
            .otp-code { font-size: 42px; font-weight: bold; color: #047857; letter-spacing: 8px; font-family: monospace; margin: 10px 0; }
            .warning-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 5px; }
            .footer { background: #1f2937; color: #9ca3af; padding: 20px; text-align: center; font-size: 12px; }
            .info-text { color: #6b7280; font-size: 14px; line-height: 1.8; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Email Verification</h1>
              <p style="margin: 5px 0 0 0; opacity: 0.9;">Pratistha Financial Services</p>
            </div>
            
            <div class="content">
              <h2 style="color: #059669; margin-top: 0;">Verify Your Email Address</h2>
              
              <p class="info-text">
                Thank you for submitting the <strong>${formType}</strong>. To complete your submission, please verify your email address using the OTP below.
              </p>

              <div class="otp-box">
                <p style="margin: 0 0 10px 0; color: #047857; font-weight: 600;">Your Verification Code</p>
                <div class="otp-code">${otp}</div>
                <p style="margin: 10px 0 0 0; color: #6b7280; font-size: 13px;">Enter this code to verify your email</p>
              </div>

              <div class="warning-box">
                <strong>Important:</strong>
                <ul style="margin: 10px 0 0 0; padding-left: 20px;">
                  <li>This OTP is valid for <strong>10 minutes</strong></li>
                  <li>Do not share this code with anyone</li>
                  <li>If you didn't request this, please ignore this email</li>
                </ul>
              </div>

              <p class="info-text">
                After verification, we will process your ${type === 'contact' ? 'inquiry' : 'loan application'} and contact you within 24-48 hours.
              </p>

              <p class="info-text" style="margin-top: 30px;">
                <strong>Need help?</strong> Contact us at ${process.env.BUSINESS_EMAIL || process.env.EMAIL_USER}
              </p>
            </div>
            
            <div class="footer">
              <p style="margin: 0;">This email was sent from Pratistha Financial Services.</p>
              <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Pratistha Financial Services. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
    text: `
Email Verification - Pratistha Financial Services

Your OTP Code: ${otp}

Please enter this code to verify your email address and complete your ${formType} submission.

Important:
- This OTP is valid for 10 minutes
- Do not share this code with anyone
- If you didn't request this, please ignore this email

Thank you for choosing Pratistha Financial Services.
    `
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`✅ OTP email sent to ${email}:`, info.messageId);
  return { success: true, messageId: info.messageId };
};

const sendContactEmail = async (contactData) => {
  const transporter = getEmailTransporter();

  const mailOptions = {
    from: `"Pratistha Financial Services" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_USER, // Send to business email
    cc: contactData.email, // Copy to customer
    subject: `New Contact Request - ${contactData.name}`,
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
              <p style="margin: 5px 0 0 0; opacity: 0.9;">Pratistha Financial Services</p>
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
              <p style="margin: 0;">This email was sent from the Pratistha Financial Services contact form.</p>
              <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Pratistha Financial Services. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`✅ Contact email sent:`, info.messageId);
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
    from: `"Pratistha Financial Services" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_USER, // Send to business email
    cc: applicationData.email, // Copy to customer
    subject: `New Loan Application - ${applicationData.loan || 'Loan'} - ${applicationData.name}`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 700px; margin: 20px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 30px; text-align: center; }
            .header h1 { margin: 0; font-size: 26px; }
            .content { padding: 30px; }
            .alert-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin-bottom: 25px; border-radius: 5px; }
            .section { background: #f9fafb; border-left: 4px solid #059669; padding: 20px; margin: 20px 0; border-radius: 5px; }
            .section h3 { color: #059669; margin: 0 0 15px 0; font-size: 18px; }
            .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
            .info-item { padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
            .info-label { font-weight: bold; color: #059669; font-size: 13px; display: block; margin-bottom: 5px; }
            .info-value { color: #1f2937; font-size: 15px; }
            .highlight-box { background: linear-gradient(135deg, #ecfdf5, #d1fae5); border: 2px solid #059669; padding: 20px; border-radius: 8px; margin: 20px 0; }
            .loan-details { display: flex; justify-content: space-around; text-align: center; }
            .loan-detail-item { flex: 1; }
            .loan-detail-value { font-size: 24px; font-weight: bold; color: #059669; display: block; }
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
              <h1>💰 New Loan Application Received</h1>
              <p>Pratistha Financial Services</p>
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
              <p style="margin: 0;">This email was sent from the Pratistha Financial Services loan application system.</p>
              <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Pratistha Financial Services. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`✅ Loan application email sent:`, info.messageId);
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

app.use('/static', express.static('static'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

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

    // Validation
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    // Rate limiting
    if (!otpRateLimiter.isAllowed(email)) {
      return res.status(429).json({
        success: false,
        message: 'Too many OTP requests. Please try again after 1 minute.'
      });
    }

    const otp = generateOTP();
    const expiryTime = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP
    otpStore.set(email, {
      otp,
      expiryTime,
      type: 'contact'
    });

    // Queue email sending (non-blocking)
    emailQueue.add(
      () => sendOTPEmail(email, otp, 'contact'),
      'high'
    ).catch(error => {
      console.error('❌ Failed to queue OTP email:', error);
    });

    console.log(`📧 OTP queued for ${email}: ${otp}`);

    // Respond immediately
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

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    if (!otpRateLimiter.isAllowed(email)) {
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

    // Queue email sending (non-blocking)
    emailQueue.add(
      () => sendOTPEmail(email, otp, 'apply'),
      'high'
    ).catch(error => {
      console.error('❌ Failed to queue OTP email:', error);
    });

    console.log(`📧 OTP queued for ${email}: ${otp}`);

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
    const { email, otp } = req.body;

    // Verify OTP
    const storedData = otpStore.get(email);

    if (!storedData) {
      return res.status(400).json({
        success: false,
        message: 'OTP not found. Please request a new OTP.'
      });
    }

    if (storedData.otp !== otp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please try again.'
      });
    }

    // OTP verified successfully - delete it
    otpStore.delete(email);

    const contactData = {
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      state: req.body.state,
      district: req.body.district,
      require: req.body.require || req.body.message
    };

    // Queue confirmation email (non-blocking)
    emailQueue.add(
      () => sendContactEmail(contactData),
      'normal'
    ).catch(error => {
      console.error('❌ Failed to queue contact email:', error);
    });

    console.log('✅ Contact form verified and queued');

    // Respond immediately
    res.status(200).json({
      success: true,
      message: 'Thank you for contacting us! Your email has been verified. We will get back to you soon.'
    });

  } catch (error) {
    console.error('❌ Contact form error:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while submitting your request. Please try again.'
    });
  }
});

// Verify OTP and submit loan application
app.post('/apply', async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Verify OTP
    const storedData = otpStore.get(email);

    if (!storedData) {
      return res.status(400).json({
        success: false,
        message: 'OTP not found. Please request a new OTP.'
      });
    }

    if (storedData.otp !== otp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please try again.'
      });
    }

    // OTP verified successfully - delete it
    otpStore.delete(email);

    const applicationData = {
      name: req.body.name,
      age: req.body.age,
      employement: req.body.employement,
      position: req.body.position,
      state: req.body.state,
      district: req.body.district,
      loan: req.body.loan,
      income: req.body.income,
      loan_amount: req.body.loan_amount,
      tenure: req.body.tenure,
      phone: req.body.phone,
      email: req.body.email
    };

    const applicationId = `LA-${Date.now()}`;

    // Queue confirmation email (non-blocking)
    emailQueue.add(
      () => sendLoanApplicationEmail(applicationData),
      'normal'
    ).catch(error => {
      console.error('❌ Failed to queue loan email:', error);
    });

    console.log('✅ Loan application verified and queued');

    // Respond immediately
    res.status(200).json({
      success: true,
      message: 'Your loan application has been submitted successfully! Your email has been verified. We will contact you within 24-48 hours.',
      applicationId
    });

  } catch (error) {
    console.error('❌ Loan application error:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while submitting your application. Please try again.'
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
    memory: process.memoryUsage(),
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
  res.status(500).json({
    success: false,
    message: 'Internal server error'
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
module.exports = app;