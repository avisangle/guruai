// Marathi UI strings, the default language. Every key here needs an English
// text in en.ts (enforced by its type).
export const mr = {
  getStarted: 'सुरू करा',
  next: 'पुढे',
  save: 'जतन करा',
  notNow: 'आत्ता नको',
  done: 'झालं',
  backToChildren: 'मुलांच्या भागात परत',
  langMr: 'मराठी',
  langEn: 'English',
  // Parent gate and parent-mode shell (wireframes g-*, p-lock-pin, pm-attention).
  parentAreaLocked: 'पालक विभाग · बंद',
  forParents: 'पालकांसाठी',
  unlockPrompt: 'GuruAI: पालक विभाग उघडा',
  pinEnter: 'GuruAI PIN टाका',
  pinOrFingerprint: 'किंवा बोटाचा ठसा वापरा',
  pinFingerprintKey: 'बोटाचा ठसा वापरा',
  pinDelete: 'खोडा',
  pinWrongTwoLeft: 'PIN चुकला. अजून 2 प्रयत्न बाकी.',
  pinWrongOneLeft: 'PIN चुकला. अजून 1 प्रयत्न बाकी.',
  pinWaitTitle: 'थोडं थांबा',
  pinWait30: '3 वेळा चुकीचा PIN टाकला. 30 सेकंदांनी पुन्हा प्रयत्न करा.',
  pinWait5: 'पुन्हा चुकीचा PIN टाकला. 5 मिनिटांनी पुन्हा प्रयत्न करा.',
  pinWait15Title: '15 मिनिटं थांबा',
  pinWait15: 'खूप वेळा चुकीचा PIN टाकला गेला. 15 मिनिटांनी पुन्हा प्रयत्न करा.',
  pinWaitLessonsGoOn: 'मुलाचे धडे नेहमीसारखे चालू राहतील.',
  pinUnlockBiometric: 'बोटाच्या ठशाने किंवा चेहऱ्याने उघडा',
  pinSetTitle: 'नवीन GuruAI PIN ठरवा',
  pinNoScreenLock: 'या फोनला स्क्रीन लॉक नाही, म्हणून GuruAI PIN ठरवावा लागेल.',
  pinFirst: 'PIN',
  pinAgain: 'तोच PIN पुन्हा',
  pinMismatch: 'दोन्ही PIN जुळले नाहीत. पुन्हा टाका.',
  pinRemember: 'PIN लक्षात ठेवा.',
  pinRememberBody:
    'विसरलात तर बोटाचा ठसा किंवा चेहरा वापरून नवीन PIN ठरवता येईल. फोनवर ते नसेल तर ॲप पुन्हा इन्स्टॉल करावं लागेल आणि प्रगती पुसली जाईल.',
  idleTitle: '2 मिनिटं काही हालचाल नाही.',
  idleBody: '10 सेकंदांत मुलांच्या भागात परत जात आहोत.',
  idleStay: 'इथेच थांबा',
};

export type StringKey = keyof typeof mr;
