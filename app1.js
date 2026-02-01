const express = require("express");
const path = require("path");
const fs = require("fs");
var mongoose = require("mongoose");
const bodyparser = require("body-parser");
const nodemailer = require("nodemailer");
require('dotenv').config();

const url = 'mongodb://127.0.0.1:27017/dk';
const app = express();
const port = 8000;

// Store OTPs temporarily (in production, use Redis or database)
const otpStore = new Map();

// Email Configuration
const emailConfig = {
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  }
};

// Create email transporter
const createTransporter = () => {
  return nodemailer.createTransporter(emailConfig);
};

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Send OTP email
const sendOTPEmail = async (email, otp, type = 'contact') => {
  const transporter = createTransporter();

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
              <h1>🔐 Email Verification</h1>
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
                <strong>⚠️ Important:</strong>
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

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ OTP email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Error sending OTP email:', error);
    throw error;
  }
};

// Email sending functions (same as before)
const sendContactEmail = async (contactData) => {
  const transporter = createTransporter();

  const mailOptions = {
    from: `"Pratistha Financial Services" <${process.env.EMAIL_USER}>`,
    to: process.env.BUSINESS_EMAIL || process.env.EMAIL_USER,
    subject: `New Contact Form Submission - ${contactData.name}`,
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
                <strong>⚠️ Action Required:</strong> New contact inquiry received. Please respond within 24 hours.
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
    `,
    text: `
New Contact Form Submission - Pratistha Financial Services
EMAIL VERIFIED ✓

Contact Information:
- Name: ${contactData.name || 'Not provided'}
- Email: ${contactData.email || 'Not provided'}
- Phone: ${contactData.phone || 'Not provided'}
- State & Pincode: ${contactData.state || 'Not provided'}
- District: ${contactData.district || 'Not provided'}

Message/Requirement:
${contactData.require || contactData.message || 'Not provided'}

Submitted on: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Contact email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Error sending contact email:', error);
    throw error;
  }
};

const sendLoanApplicationEmail = async (applicationData) => {
  const transporter = createTransporter();

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
    to: process.env.BUSINESS_EMAIL || process.env.EMAIL_USER,
    subject: `🔔 New Loan Application - ${applicationData.loan || 'Loan'} - ${applicationData.name}`,
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
            .action-buttons { margin-top: 25px; text-align: center; }
            .action-buttons a { display: inline-block; background: #059669; color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; margin: 5px; font-weight: bold; }
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
                <strong>⚡ Priority Application:</strong> New loan application received. Please review and contact within 24-48 hours.
              </div>

              <span class="verified-badge">✓ EMAIL VERIFIED</span>

              <div class="highlight-box">
                <h3>📊 Loan Summary</h3>
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

              <div class="action-buttons">
                <a href="tel:${applicationData.phone}">📞 Call Applicant</a>
                <a href="mailto:${applicationData.email}">📧 Send Email</a>
              </div>
            </div>
            
            <div class="footer">
              <p style="margin: 0;">This email was sent from the Pratistha Financial Services loan application system.</p>
              <p style="margin: 5px 0 0 0;">© ${new Date().getFullYear()} Pratistha Financial Services. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `,
    text: `
New Loan Application - Pratistha Financial Services
EMAIL VERIFIED ✓

LOAN SUMMARY:
- Loan Amount: ₹${applicationData.loan_amount || 'N/A'}
- Tenure: ${applicationData.tenure || 'N/A'} years
- Estimated Monthly EMI: ₹${estimatedEMI}

PERSONAL INFORMATION:
- Name: ${applicationData.name || 'Not provided'}
- Age: ${applicationData.age || 'Not provided'}
- Employment: ${applicationData.employement || 'Not provided'}
- Position: ${applicationData.position || 'Not provided'}
- State & Pincode: ${applicationData.state || 'Not provided'}
- District: ${applicationData.district || 'Not provided'}

LOAN REQUIREMENTS:
- Type of Loan: ${applicationData.loan || 'Not provided'}
- Monthly Income: ₹${applicationData.income || 'Not provided'}
- Loan Amount: ₹${applicationData.loan_amount || 'Not provided'}
- Tenure: ${applicationData.tenure || 'Not provided'} years

CONTACT INFORMATION:
- Phone: ${applicationData.phone || 'Not provided'}
- Email: ${applicationData.email || 'Not provided'}

Application ID: LA-${Date.now()}
Submitted on: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Loan application email sent successfully:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Error sending loan application email:', error);
    throw error;
  }
};

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
app.set('views', path.join(__dirname, 'views'));

// ENDPOINTS
app.get('/', (req, res) => {
  const params = { 'title': 'welcome !!' }
  res.status(200).render('index.pug', params);
})

app.get('/applyloan', (req, res) => {
  const params = {}
  res.status(200).render('apply.pug', params);
})

app.get('/contact', (req, res) => {
  const params = {}
  res.status(200).render('contact.pug');
})

app.get('/services', (req, res) => {
  const params = {}
  res.status(200).render('services.pug');
})

app.get('/EMI', (req, res) => {
  const params = {}
  res.status(200).render('services.pug');
})

app.get('/about', (req, res) => {
  const params = {}
  res.status(200).render('about.pug');
})

// API Endpoints for OTP

// Send OTP for contact form
app.post('/api/send-otp-contact', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
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

    // Send OTP email
    await sendOTPEmail(email, otp, 'contact');

    console.log(`📧 OTP sent to ${email}: ${otp}`);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your email'
    });

  } catch (error) {
    console.error('Error sending OTP:', error);
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

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const otp = generateOTP();
    const expiryTime = Date.now() + 10 * 60 * 1000;

    otpStore.set(email, {
      otp,
      expiryTime,
      type: 'apply'
    });

    await sendOTPEmail(email, otp, 'apply');

    console.log(`📧 OTP sent to ${email}: ${otp}`);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your email'
    });

  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP. Please try again.'
    });
  }
});

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

    if (Date.now() > storedData.expiryTime) {
      otpStore.delete(email);
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new OTP.'
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

    // Send email notification
    try {
      await sendContactEmail(contactData);
      console.log('📧 Contact form email sent successfully');
    } catch (emailError) {
      console.error('⚠️ Email sending failed, but form verified:', emailError.message);
    }

    // Save to database (if you have mongoose model)
    // var myData = new newdata(req.body);
    // await myData.save();

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

    if (Date.now() > storedData.expiryTime) {
      otpStore.delete(email);
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new OTP.'
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

    // Send email notification
    try {
      await sendLoanApplicationEmail(applicationData);
      console.log('📧 Loan application email sent successfully');
    } catch (emailError) {
      console.error('⚠️ Email sending failed, but form verified:', emailError.message);
    }

    // Save to database (if you have mongoose model)
    // var myDatae = new newdatae(req.body);
    // await myDatae.save();

    res.status(200).json({
      success: true,
      message: 'Your loan application has been submitted successfully! Your email has been verified. We will contact you within 24-48 hours.',
      applicationId: `LA-${Date.now()}`
    });

  } catch (error) {
    console.error('❌ Loan application error:', error);
    res.status(500).json({
      success: false,
      message: 'An error occurred while submitting your application. Please try again.'
    });
  }
});

// START THE SERVER
app.listen(port, () => {
  console.log(`\n🚀 Server started successfully!`);
  console.log(`📍 Server running on: http://localhost:${port}`);
  console.log(`📧 Email notifications enabled: ${process.env.EMAIL_USER ? '✅ YES' : '❌ NO - Configure .env file'}`);
  console.log(`📬 Business email: ${process.env.BUSINESS_EMAIL || process.env.EMAIL_USER || 'Not configured'}`);
  console.log(`🔐 OTP verification enabled for both forms`);
  console.log(`\n👉 Make sure to configure your .env file with Gmail credentials!\n`);
});