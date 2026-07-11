/**
 * Synthetic + public-guidance knowledge corpus for RAG grounding.
 * (Fictional agency policy — safe to show on stage. No real PHI anywhere.)
 */
export const KNOWLEDGE_DOCS: { title: string; chunk: string }[] = [
  {
    title: "Admission criteria",
    chunk:
      "CareLine Home Health accepts adult patients (18+) requiring skilled nursing, physical therapy, occupational therapy, speech therapy, or home health aide services. Patients must reside within our service area and have a physician willing to sign home health orders. Common qualifying conditions: post-surgical recovery, CHF, COPD, diabetes management, wound care, stroke recovery, fall risk. We do not provide 24/7 in-home care or emergency services.",
  },
  {
    title: "Service area",
    chunk:
      "We currently serve the five boroughs of New York City (Manhattan, Brooklyn, Queens, Bronx, Staten Island), plus Nassau and Westchester counties. Patients outside this area are referred to partner agencies.",
  },
  {
    title: "Insurance accepted",
    chunk:
      "We accept Medicare (traditional and Medicare Advantage), Medicaid (NY), Aetna, UnitedHealthcare, Empire BlueCross BlueShield, Cigna, and Humana. We verify eligibility within one business day of intake. Private pay plans are available. For Medicare home health, the patient must be homebound and require intermittent skilled care as certified by a physician.",
  },
  {
    title: "What happens after intake",
    chunk:
      "After intake is complete: 1) Insurance eligibility is verified (within 1 business day). 2) A care coordinator calls to schedule the start-of-care visit, typically within 24-48 hours. 3) A registered nurse performs the initial assessment at home (OASIS assessment for Medicare). 4) The personalized care plan is confirmed with the patient's physician.",
  },
  {
    title: "Required intake information",
    chunk:
      "A complete intake requires: patient full name, date of birth, home address, callback phone number, primary diagnosis or reason for care, insurance payer and member ID, and the referral source (hospital, physician, or self-referral). Helpful extras: physician name, urgency, preferred language, photo of the insurance card, and any referral or discharge paperwork.",
  },
  {
    title: "Languages and accessibility",
    chunk:
      "CareLine's intake assistant supports conversation in over 30 languages including Spanish, Mandarin, Cantonese, Hindi, Bengali, Russian, Haitian Creole, Korean, and Arabic, by text or voice, 24 hours a day. Human interpreters are available for start-of-care visits on request.",
  },
  {
    title: "Escalation and clinical questions",
    chunk:
      "The intake assistant never provides medical advice, medication guidance, or triage. Clinical questions are routed to an on-call registered nurse who responds within 30 minutes during business hours and 2 hours after-hours. If a caller describes an emergency, they are directed to call 911 immediately.",
  },
  {
    title: "Caregiver matching",
    chunk:
      "Caregivers are matched on skill requirements, language, and location. Current roster highlights (synthetic demo data): Maria G. (RN, Spanish/English, Queens), Wei L. (RN, Mandarin/English, Manhattan), Priya S. (PT, Hindi/English, Brooklyn), Jean-Paul D. (HHA, Haitian Creole/French/English, Brooklyn), Olga K. (RN wound care, Russian/English, Staten Island).",
  },
  {
    title: "Privacy and data handling",
    chunk:
      "Intake conversations are encrypted in transit. This demo runs entirely on synthetic data — no real patient information is collected or stored. In production, CareLine follows HIPAA minimum-necessary standards, and callers may request a human coordinator at any time.",
  },
];
