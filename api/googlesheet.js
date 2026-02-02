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

    console.log('✅ Google Sheets client initialized');
    return sheetsClient;
}

const SPREADSHEET_ID = process.env.SPREADSHEET_ID_LOAN;
const SHEET_NAME = process.env.SHEET_NAME_LOAN || 'Loan Applications';

// ====================================================================================
// HEADERS
// ====================================================================================
const HEADERS = [
    'Application ID',
    'Name',
    'Age',
    'Employment',
    'Position',
    'State',
    'District',
    'Loan Type',
    'Monthly Income',
    'Loan Amount',
    'Tenure (Years)',
    'Phone',
    'Email',
    'Status',
    'Created At',
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
function validateLoanData(data) {
    const errors = [];

    if (!data.name || data.name.trim().length < 2) errors.push('Invalid name');
    if (!data.phone) errors.push('Phone required');
    if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
        errors.push('Invalid email');

    const age = Number(data.age);
    if (!Number.isInteger(age) || age < 18 || age > 100)
        errors.push('Invalid age');

    if (!data.employement) errors.push('Employment required');
    if (!data.loan) errors.push('Loan type required');

    return errors;
}

function formatCurrency(val) {
    const num = Number(val);
    return isNaN(num) ? '0' : num.toLocaleString('en-IN');
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
        range: `${SHEET_NAME}!A1:O1`,
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
// ADD LOAN
// ====================================================================================
export async function addLoanClient(data, applicationId) {
    const errors = validateLoanData(data);
    if (errors.length) throw new Error(errors.join(', '));

    const sheets = await getSheetsClient();
    await ensureSheetAndHeaders();

    const row = [
        sanitizeForSheets(applicationId),
        sanitizeForSheets(data.name),
        data.age,
        sanitizeForSheets(data.employement),
        sanitizeForSheets(data.position || 'N/A'),
        sanitizeForSheets(data.state),
        sanitizeForSheets(data.district),
        sanitizeForSheets(data.loan),
        formatCurrency(data.income),
        formatCurrency(data.loan_amount),
        data.tenure,
        sanitizeForSheets(data.phone),
        sanitizeForSheets(data.email),
        'Pending',
        new Date().toISOString(),
    ];

    const res = await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A2`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
    });

    return { success: true, range: res.data.updates.updatedRange };
}

// ====================================================================================
// UPDATE STATUS
// ====================================================================================
export async function updateLoanStatus(applicationId, status) {
    const sheets = await getSheetsClient();

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:A`,
    });

    const idx = (res.data.values || []).findIndex(r => r[0] === applicationId);
    if (idx === -1) throw new Error('Application ID not found');

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!N${idx + 1}`,
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
    addLoanClient,
    updateLoanStatus,
    checkHealth,
};
