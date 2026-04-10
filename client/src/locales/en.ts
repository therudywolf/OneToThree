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
  'login.invalidUsernameFormat':
    'Handle must be 3–20 characters: English letters, digits, dot, underscore, or hyphen only (no spaces or emoji).',
  'login.usernameReserved': 'That handle is reserved. Choose another.',
  'login.invalidBody': 'Invalid request.',
  'login.handleLabel': 'Handle',
  'login.vaultPassphraseLabel': 'Vault passphrase',
  'login.handlePlaceholder': 'operator',
  'login.authLoading': 'Checking session...',
  'login.newDevice': 'New device',
  'login.existingVault': 'Existing vault',
  'login.tosRegisterTitle': '[ EN ] Terms of Service',
  'login.tosRegisterBody': `Privacy & Encryption: This service provides End-to-End encryption. We physically cannot access your messages or keys. Losing your Vault passphrase means permanent loss of your chat history.

Zero Liability Zone: By entering, you accept full responsibility for your actions at your own risk. This is a free board. We do not moderate content, we are not liable for it, and we do not care how you use these tools. Every user is solely responsible for the consequences of their actions.

Limitation of Liability: The service is provided "As-Is". The administration is not liable for any damages or data loss.

Right to Terminate: This is a private bunker. The administration reserves the right to ban any account at any time, without prior notice or explanation.`,

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
    'You can hide from username search in Settings (Discoverable). Others need it on to be found by name; invite links always work.',
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

  'group.dialogAria': 'Create encrypted group',
  'group.title': '[ NEW_GROUP_E2E ]',
  'group.hintEcdh':
    'Each member must have ECDH published (unlock vault once so keys sync to the server).',
  'group.channelName': '> CHANNEL_NAME',
  'group.optional': 'optional',
  'group.searchLabel': '> RADAR_SEARCH',
  'group.searchPlaceholder': 'username, UUID, or pasted invite link',
  'group.scanning': 'SCAN…',
  'group.noHits':
    'NO_HITS — user must be discoverable in Settings, or search by exact UUID / invite.',
  'group.noEcdhBadge': 'NO_ECDH',
  'group.selectedLabel': ':: selected',
  'group.selectHint': 'Pick at least one user from the list above.',
  'group.create': 'CREATE',
  'group.creating': '…',
  'group.cancel': 'CANCEL',
  'group.noVault': 'Session vault is locked — unlock the vault first.',
  'group.noSession': 'No user id in session — reload the page.',
  'group.needMember': 'Add at least one other member.',
  'group.missingEcdh':
    'User «{name}» has no ECDH on the server — they must unlock vault once.',
  'group.lookupFailed': 'Could not load user profiles from the server.',
  'group.unknownUser': 'One of the users does not exist on the server.',
  'group.createFailed': 'Group creation failed.',
  'group.timeout': 'Request timed out — try again or check the network.',
  'group.serverInvalid': 'Invalid request to server.',
  'group.serverDuplicate': 'Duplicate member in request.',
  'group.creatorMissing': 'Creator must be included in the member list.',

  'settings.discoverable': 'Discoverable',
  'settings.discoverableHint':
    'Lets others find you by username. To find someone else, they must enable this too.',
  'settings.discoverableBadgeOn': '● visible in username search',
  'settings.discoverableBadgeOff': '○ hidden from username search',
  'settings.discoverableTooltipOn': 'Others can find you by nickname (search)',
  'settings.discoverableTooltipOff': 'You are not listed in nickname search',
  'settings.loadFailed': 'Could not load settings (check login / network)',
  'settings.vaultBackup': 'Vault backup',
  'settings.languageHint': 'Choose interface language',
  'settings.noLocalVault': 'No local vault',
  'settings.invalidVaultFile': 'Invalid vault file',
  'settings.importFailed': 'Import failed',
  'settings.toggleFailed': 'Failed to update setting',
  'settings.unknown': 'Unknown error',
  'settings.dangerZone': 'Danger zone',
  'settings.purgeHint':
    'Clears localStorage, sessionStorage, and the message IndexedDB — use when debugging corrupt local state.',
  'settings.purgeLocalCache': 'PURGE LOCAL CACHE',
} as const

export default en

