const en = {
  'common.back': 'Back',
  'common.next': 'Next',
  'common.skip': 'Skip',
  'common.saved': 'Saved',
  'common.settings': 'Settings',
  'common.language': 'Language',
  'common.openChatAria': 'Open chat',
  'common.peerInputAria': 'Peer UUID or username',
  'common.copyInviteAria': 'Copy my invite link',
  'common.createGroupAria': 'Create group E2E',
  'common.toggleLanguageAria': 'Toggle language',

  'login.usernameRequired': 'Username is required.',
  'login.passwordRequired': 'Passphrase is required.',
  'login.pinMin8': 'Passphrase must be at least 8 characters for new keys.',
  'login.noLocalVault':
    'No local vault for this handle. Register on this device first.',
  'login.vaultExists': 'A vault already exists for this handle. Use login.',
  'login.unwrapFailed': 'Wrong passphrase or corrupted vault.',
  'login.invalidVaultFormat': 'Vault data is invalid.',
  'login.legacyVault':
    'This vault predates ECDSA auth. Register a new handle or clear local data.',
  'login.invalidSigningKey': 'Could not load signing key from vault.',
  'login.signFailed': 'Signing the challenge failed.',
  'login.challengeFailed': 'Could not reach auth server.',
  'login.verifyFailed': 'Verification failed.',
  'login.unauthorized': 'Session invalid.',
  'login.noChallenge': 'No active challenge, try again.',
  'login.nonceMismatch': 'Challenge mismatch, try again.',
  'login.signatureInvalid': 'Signature rejected by server.',
  'login.publicKeyRequired': 'Server expected a public key (registration).',
  'login.publicKeyConflict':
    'This handle is already registered on the server with a different key. Use Login with your original vault, pick another handle, or reset the server DB and local site data.',
  'login.usernameTaken': 'That handle is already taken.',
  'login.invalidBody': 'Invalid request.',
  'login.handleLabel': 'Handle',
  'login.vaultPassphraseLabel': 'Vault passphrase',
  'login.handlePlaceholder': 'operator',
  'login.authLoading': 'Checking session...',
  'login.newDevice': 'New device',
  'login.existingVault': 'Existing vault',

  'guide.step': 'Step',
  'guide.onboardingTitle': 'Onboarding',
  'guide.enter': 'Enter Project 13',
  'guide.keyGeneration.title': 'Key generation',
  'guide.keyGeneration.body':
    'When you register, your browser generates two cryptographic key pairs: ECDSA (authentication) and ECDH (E2E encryption). Private keys never leave your device.',
  'guide.vaultEncryption.title': 'Vault encryption',
  'guide.vaultEncryption.body':
    'Your private keys are wrapped with AES-256-GCM using a passphrase-derived key (PBKDF2, 210k iterations). The encrypted vault is stored in localStorage.',
  'guide.zeroKnowledge.title': 'Zero knowledge',
  'guide.zeroKnowledge.body':
    'The server stores only public keys and encrypted message blobs. It cannot read messages or decrypt media.',
  'guide.discoverability.title': 'Discoverability',
  'guide.discoverability.body':
    'By default your account is hidden. Enable Discoverable in Settings to be found by username.',
  'guide.backup.title': 'Back up your vault',
  'guide.backup.body':
    'Use Settings -> Export Vault to save an encrypted backup. Import it on a new device to restore access.',

  'sidebar.channels': 'Channels',
  'sidebar.openDirect': 'Open direct',
  'sidebar.peerPlaceholder': 'peer UUID or username',
  'sidebar.copyInviteSuccess': 'Invite link copied',
  'sidebar.userNotFound': 'User not found or hidden',
  'sidebar.cannotOpenSelf': 'You cannot open a direct chat with yourself',
  'sidebar.createFailed': 'Failed to create chat',

  'settings.discoverable': 'Discoverable',
  'settings.discoverableHint': 'Visible in public user search',
  'settings.vaultBackup': 'Vault backup',
  'settings.languageHint': 'Choose interface language',
  'settings.noLocalVault': 'No local vault',
  'settings.invalidVaultFile': 'Invalid vault file',
  'settings.importFailed': 'Import failed',
  'settings.toggleFailed': 'Failed to update setting',
  'settings.unknown': 'Unknown error',
} as const

export default en

