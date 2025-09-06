require('dotenv').config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const poppler = require("pdf-poppler");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

// Load Gemini API key from environment
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY environment variable not set");
}
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Convert PDF to images using poppler (keep for previews)
async function convertPDFtoImages(pdfPath, outputDir) {
  const opts = {
    format: "png",
    out_dir: outputDir,
    out_prefix: "page",
    page: null
  };

  try {
    await poppler.convert(pdfPath, opts);
    const files = fs.readdirSync(outputDir)
      .filter(f => f.endsWith(".png"))
      .map(f => path.join(outputDir, f))
      .sort();
    return files;
  } catch (err) {
    console.error("PDF to image conversion error:", err.message);
    return [];
  }
}

// Normalization function for comparison (matching original logic)
const normalize = (str) => {
  if (!str) return '';
  return String(str).trim().toLowerCase().replace(/[\s,-.]+/g, '');
};

// Name-specific matching function
const isNameMatch = (userName, docName) => {
  if (!userName || !docName) return false;
  const commonTitles = ['mr', 'mrs', 'ms', 'dr', 'prof', 'miss'];
  const clean = (s) => s.trim().toLowerCase().replace(/[.,]/g, '');
  const getWords = (s) => clean(s).split(/\s+/).filter(w => w && !commonTitles.includes(w));
  const userWords = getWords(userName);
  const docWords = getWords(docName);
  return userWords.every(word => docWords.includes(word));
};

// Get type-specific configuration (fields, prompt, schema)
function getDocTypeConfig(docType) {
  switch (docType) {
    case "sales":
      return {
        fields: [
          { key: "cost", label: "Cost" },
          { key: "saleDate", label: "Sale Date" },
          { key: "ownerName", label: "Owner Name" },
          { key: "salespersonName", label: "Salesperson Name" },
          { key: "location", label: "Location" }
        ],
        prompt: "From the attached sales document PDF, extract the following information and return it as a JSON object: cost, sale date (format YYYY-MM-DD), owner name, salesperson name, and location. Also, provide a brief summary for each page of the document. If a value is not found, return null for that key.",
        schemaProperties: {
          cost: { type: "string" },
          saleDate: { type: "string" },
          ownerName: { type: "string" },
          salespersonName: { type: "string" },
          location: { type: "string" }
        },
        required: ["cost", "saleDate", "ownerName", "salespersonName", "location"]
      };
    case "gift":
      return {
        fields: [
          
          { key: "giftDate", label: "Gift Date" },
          { key: "giverName", label: "Giver Name" },
          { key: "receiverName", label: "Receiver Name" },
          { key: "location", label: "Enter Location where gift is received" },
          { key: "giftType", label: "Gift Type" }
        ],
        prompt: "From the attached gift giving document PDF, extract the following information and return it as a JSON object: gift date (format YYYY-MM-DD), giver name (donor name, which may be in any format), receiver name (donee name, which may be in any format), location (the address following the phrase 'Location of where the gift deed is received/ registered - '), and gift type. If the document contains keywords such as 'apartment' or 'car parking', set gift type to 'Immovable property'. Also extract address components as an object with street, city, state, country, zip. Also, provide a brief summary for each page of the document. If a value is not found, return null for that key.",
        schemaProperties: {
          
          giftDate: { type: "string" },
          giverName: { type: "string" },
          receiverName: { type: "string" },
          location: { type: "string" },
          giftType: { type: "string" },
          addressComponents: {
            type: "object",
            properties: {
              street: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              country: { type: "string" },
              zip: { type: "string" }
            }
          }
        },
        required: ["giftDate", "giverName", "receiverName", "location", "giftType", "addressComponents"]
      };
    case "rental":
      return {
        fields: [
          { key: "rentAmount", label: "Rent Amount" },
          { key: "startDate", label: "Start Date" },
          { key: "endDate", label: "End Date" },
          { key: "tenantName", label: "Tenant Name" },
          { key: "landlordName", label: "Landlord Name" },
          { key: "propertyLocation", label: "Property Location" }
        ],
        prompt: "From the attached rental agreement PDF, extract the following information and return it as a JSON object: rent amount, start date (format YYYY-MM-DD), end date (format YYYY-MM-DD), tenant name, landlord name, and property location. Also, provide a brief summary for each page of the document. If a value is not found, return null for that key.",
        schemaProperties: {
          rentAmount: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
          tenantName: { type: "string" },
          landlordName: { type: "string" },
          propertyLocation: { type: "string" }
        },
        required: ["rentAmount", "startDate", "endDate", "tenantName", "landlordName", "propertyLocation"]
      };
    case "authority":
      return {
        fields: [
          { key: "grantorName", label: "Grantor Name" },
          { key: "granteeName", label: "Grantee Name" },
          { key: "authorityType", label: "Authority Type" },
          { key: "validity", label: "Validity" },
          { key: "location", label: "Location" }
        ],
        prompt: "From the attached power of authority document PDF, extract the following information and return it as a JSON object: grantor name, grantee name, authority type, validity date (format YYYY-MM-DD), and location. Also, provide a brief summary for each page of the document. If a value is not found, return null for that key.",
        schemaProperties: {
          grantorName: { type: "string" },
          granteeName: { type: "string" },
          authorityType: { type: "string" },
          validity: { type: "string" },
          location: { type: "string" }
        },
        required: ["grantorName", "granteeName", "authorityType", "validity", "location"]
      };
    default:
      throw new Error(`Unsupported document type: ${docType}`);
  }
}

// Extract and compare using Gemini
async function extractAndCompare(base64Pdf, userData, docType) {
  const config = getDocTypeConfig(docType);

  const responseSchema = {
    type: "object",
    properties: {
      ...config.schemaProperties,
      pageSummaries: {
        type: "array",
        items: { type: "string", description: "A brief summary of the content on a single page." },
        description: "An array of strings, where each string is a summary of the corresponding page in the document."
      }
    },
    required: [...config.required, "pageSummaries"]
  };

  const parts = [
    {
      inlineData: {
        mimeType: 'application/pdf',
        data: base64Pdf
      }
    },
    {
      text: config.prompt
    }
  ];

  const generationConfig = {
    responseMimeType: "application/json",
    responseSchema: responseSchema
  };

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts }],
      generationConfig
    });

    // Updated response handling for @google/generative-ai v0.17.1
    const responseText = result.response.candidates[0]?.content?.parts[0]?.text;
    if (!responseText) {
      throw new Error("No valid response text received from Gemini API");
    }

    let extracted;
    try {
      extracted = JSON.parse(responseText.trim()) || {};
    } catch (parseError) {
      console.error("Failed to parse Gemini response as JSON:", parseError.message);
      throw new Error("Invalid JSON response from Gemini API");
    }

    const details = config.fields.map(field => {
      const userValue = userData[field.key] || "";
      const docValue = extracted[field.key] || "Not Found";
      let status;
      if (field.key === "giverName" || field.key === "receiverName") {
        status = isNameMatch(userValue, docValue) ? "✅ Match" : "❌ Mismatch";
      } else {
        status = normalize(userValue) === normalize(docValue) ? "✅ Match" : "❌ Mismatch";
      }
      return {
        field: field.label,
        userData: userValue,
        dataFromDocument: docValue,
        status
      };
    });

    const allMatch = details.every(d => d.status === "✅ Match");
    return { 
      status: allMatch ? "Original" : "Fake", 
      details, 
      pageSummaries: extracted.pageSummaries || [],
      addressComponents: extracted.addressComponents || {}
    };
  } catch (err) {
    console.error("Gemini API error:", err.message);
    throw new Error("Failed to extract details using Gemini API: " + err.message);
  }
}

// Generate analysis (updated for all types with unique variable names)
function generateAnalysis(docType, details) {
  const getDetail = (fieldName) => details.find(d => d.field === fieldName)?.dataFromDocument || "[not found]";

  switch (docType) {
    case "sales":
      const salesCost = getDetail("Cost");
      const saleDate = getDetail("Sale Date");
      const ownerName = getDetail("Owner Name");
      const salespersonName = getDetail("Salesperson Name");
      const salesLocation = getDetail("Location");
      return `This appears to be a sales document for a transaction costing ${salesCost} on ${saleDate}, involving owner ${ownerName} and salesperson ${salespersonName} at location ${salesLocation}. The following table breaks down the comparison between the user-provided data and the document's contents.`;
    case "gift":
      
      const giftDate = getDetail("Gift Date");
      const giverName = getDetail("Giver Name");
      const receiverName = getDetail("Receiver Name");
      const giftLocation = getDetail("Enter Location where gift is received");
      const giftType = getDetail("Gift Type");
      return `This appears to be a gift giving document for a ${giftType}, given on ${giftDate} from ${giverName} to ${receiverName} at location ${giftLocation}. The following table breaks down the comparison between the user-provided data and the document's contents.`;
    case "rental":
      const landlord = getDetail("Landlord Name");
      const tenant = getDetail("Tenant Name");
      const rent = getDetail("Rent Amount");
      const startDate = getDetail("Start Date");
      const rentalLocation = getDetail("Property Location");
      return `This appears to be a rental agreement between the landlord, ${landlord}, and the tenant, ${tenant}. The agreement, starting on ${startDate}, is for the property located at ${rentalLocation}. The specified monthly rent is ₹${rent}. The following table breaks down the comparison between the user-provided data and the document's contents.`;
    case "authority":
      const grantor = getDetail("Grantor Name");
      const grantee = getDetail("Grantee Name");
      const authorityType = getDetail("Authority Type");
      const validity = getDetail("Validity");
      const authLocation = getDetail("Location");
      return `This appears to be a power of authority document granting ${authorityType} from ${grantor} to ${grantee}, valid until ${validity}, at location ${authLocation}. The following table breaks down the comparison between the user-provided data and the document's contents.`;
    default:
      return "Analysis for this document type has not been implemented.";
  }
}

app.post("/api/verify-document", upload.single("document"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No document uploaded." });
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-verifier-"));

  try {
    const verificationId = crypto.randomUUID();
    console.log(`Starting verification process with ID: ${verificationId}`);

    const { docType } = req.body;
    const pdfPath = req.file.path;
    const base64Pdf = fs.readFileSync(pdfPath, 'base64');

    const images = await convertPDFtoImages(pdfPath, tempDir);

    if (images.length === 0) {
      throw new Error("PDF to image conversion failed. Check 'poppler' installation.");
    }

    const imageBase64 = images.map(img => fs.readFileSync(img).toString("base64"));

    const comparisonResult = await extractAndCompare(base64Pdf, req.body, docType);
    const analysis = generateAnalysis(docType, comparisonResult.details);

    res.json({
      ...comparisonResult,
      verificationId,
      images: imageBase64,
      analysis,
      docType
    });
  } catch (err) {
    console.error("Error verifying document:", err.message);
    res.status(500).json({
      error: "Failed to verify document.",
      details: err.message
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.unlinkSync(req.file.path);
  }
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));