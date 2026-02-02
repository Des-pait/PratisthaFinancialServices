import 'dotenv/config';
import { google } from 'googleapis';

// ====================================================================================
// GOOGLE SHEETS AUTH (SINGLETON)
// ====================================================================================
let sheetsClient = null;

async function getSheetsClient() {
    if (sheetsClient) return sheetsClient;

    if (
        !process.env.GOOGLE_PROJECT_ID ||
        !process.env.GOOGLE_CLIENT_EMAIL ||
        !process.env.GOOGLE_PRIVATE_KEY
    ) {
        throw new Error('Missing Google Sheets credentials');
    }

    const auth = new google.auth.GoogleAuth({
        credentials: {
            project_id: process.env.GOOGLE_PROJECT_ID,
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const client = await auth.getClient();
    sheetsClient = google.sheets({ version: 'v4', auth: client });

    console.log('✅ Google Sheets client initialized (Contact)');
    return sheetsClient;
}

const SPREADSHEET_ID = process.env.SPREADSHEET_ID_CONTACT;
const SHEET_NAME = process.env.SHEET_NAME_CONTACT || 'Contacts';

// ====================================================================================
// HEADERS
// ====================================================================================
const HEADERS = [
    'Contact ID',
    'Name',
    'Email',
    'Phone',
    'State',
    'District',
    'Requirement / Message',
    'Status',
    'Submitted At'
];

// ====================================================================================
// SECURITY
// ====================================================================================
function sanitizeForSheets(value) {
    if (value === null || value === undefined) return '';
    let text = String(value).trim();
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return text;
}

// ====================================================================================
// VALIDATION
// ====================================================================================
function validateContactData(data) {
    const errors = [];

    if (!data.name || data.name.trim().length < 2) errors.push('Invalid name');
    if (!data.phone) errors.push('Phone required');
    if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
        errors.push('Invalid email');
    if (!data.state || data.state.trim().length < 2) errors.push('State required');
    if (!data.district || data.district.trim().length < 2) errors.push('District required');

    return errors;
}

// ====================================================================================
// ENSURE SHEET + HEADERS (AUTO CREATE)
// ====================================================================================
async function ensureSheetAndHeaders() {
    const sheets = await getSheetsClient();

    const meta = await sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
    });

    let sheet = meta.data.sheets.find(
        s => s.properties.title === SHEET_NAME
    );

    let sheetId;

    // CREATE SHEET IF MISSING
    if (!sheet) {
        const res = await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
                requests: [{
                    addSheet: {
                        properties: {
                            title: SHEET_NAME,
                            gridProperties: {
                                rowCount: 1000,
                                columnCount: HEADERS.length,
                            },
                        },
                    },
                }],
            },
        });

        sheetId = res.data.replies[0].addSheet.properties.sheetId;
        console.log(`🆕 Sheet "${SHEET_NAME}" created`);
    } else {
        sheetId = sheet.properties.sheetId;
    }

    // CHECK HEADER
    const headerCheck = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1:I1`,
    });

    const missingHeader =
        !headerCheck.data.values ||
        headerCheck.data.values[0]?.every(c => c === '');

    if (!missingHeader) return;

    // WRITE HEADER
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS] },
    });

    // FORMAT HEADER
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
            requests: [
                {
                    repeatCell: {
                        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                        cell: {
                            userEnteredFormat: {
                                backgroundColor: { red: 0.04, green: 0.71, blue: 0.51 },
                                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                                horizontalAlignment: 'CENTER',
                            },
                        },
                        fields: 'userEnteredFormat',
                    },
                },
                {
                    updateSheetProperties: {
                        properties: {
                            sheetId,
                            gridProperties: { frozenRowCount: 1 },
                        },
                        fields: 'gridProperties.frozenRowCount',
                    },
                },
            ],
        },
    });

    console.log('🧱 Headers initialized');
}

// ====================================================================================
// CHECK IF CONTACT ID EXISTS (IDEMPOTENCY)
// ====================================================================================
async function contactExists(contactId) {
    try {
        const sheets = await getSheetsClient();

        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:A`,
        });

        const values = res.data.values || [];

        // Skip header row and check if contactId exists
        return values.slice(1).some(row => row[0] === contactId);
    } catch (error) {
        console.error('❌ Error checking contact existence:', error);
        return false; // If check fails, allow insertion (fail-safe)
    }
}

// ====================================================================================
// ADD CONTACT (WITH IDEMPOTENCY)
// ====================================================================================
export async function addContactClient(data, contactId) {
    const errors = validateContactData(data);
    if (errors.length) throw new Error(errors.join(', '));

    const sheets = await getSheetsClient();
    await ensureSheetAndHeaders();

    // ✅ IDEMPOTENCY CHECK: Prevent duplicate insertions
    const exists = await contactExists(contactId);
    if (exists) {
        console.warn(`⚠️ Contact ${contactId} already exists - skipping duplicate insertion`);
        return {
            success: true,
            duplicate: true,
            message: 'Contact already exists',
            contactId
        };
    }

    const row = [
        sanitizeForSheets(contactId),
        sanitizeForSheets(data.name),
        sanitizeForSheets(data.email),
        sanitizeForSheets(data.phone),
        sanitizeForSheets(data.state),
        sanitizeForSheets(data.district),
        sanitizeForSheets(data.require || ''),
        'New',
        new Date().toISOString(),
    ];

    const res = await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A2`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
    });

    console.log(`✅ Contact ${contactId} added successfully`);

    return {
        success: true,
        range: res.data.updates.updatedRange,
        contactId
    };
}

// ====================================================================================
// UPDATE STATUS
// ====================================================================================
export async function updateContactStatus(contactId, status) {
    const sheets = await getSheetsClient();

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:A`,
    });

    const idx = (res.data.values || []).findIndex(r => r[0] === contactId);
    if (idx === -1) throw new Error('Contact ID not found');

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!H${idx + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[sanitizeForSheets(status)]] },
    });

    return { success: true };
}

// ====================================================================================
// HEALTH
// ====================================================================================
export async function checkHealth() {
    try {
        const sheets = await getSheetsClient();
        await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        return { healthy: true };
    } catch (e) {
        return { healthy: false, error: e.message };
    }
}

export default {
    addContactClient,
    updateContactStatus,
    checkHealth,
};