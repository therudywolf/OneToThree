const ru = {
  'common.back': 'Назад',
  'common.next': 'Далее',
  'common.skip': 'Пропустить',
  'common.saved': 'Сохранено',
  'common.settings': 'Настройки',
  'common.language': 'Язык',
  'common.openChatAria': 'Открыть чат',
  'common.peerInputAria': 'UUID или имя пользователя',
  'common.copyInviteAria': 'Скопировать мою ссылку-приглашение',
  'common.createGroupAria': 'Создать E2E группу',
  'common.toggleLanguageAria': 'Переключить язык',

  'login.usernameRequired': 'Требуется имя пользователя.',
  'login.passwordRequired': 'Требуется парольная фраза.',
  'login.pinMin8':
    'Для новых ключей парольная фраза должна быть не короче 8 символов.',
  'login.noLocalVault':
    'Для этого пользователя нет локального vault. Сначала зарегистрируйтесь на этом устройстве.',
  'login.vaultExists':
    'Для этого пользователя уже есть vault. Используйте вход.',
  'login.unwrapFailed': 'Неверная парольная фраза или поврежденный vault.',
  'login.invalidVaultFormat': 'Данные vault имеют неверный формат.',
  'login.legacyVault':
    'Этот vault создан до ECDSA-авторизации. Зарегистрируйте новый логин или очистите локальные данные.',
  'login.invalidSigningKey':
    'Не удалось загрузить ключ подписи из vault.',
  'login.signFailed': 'Не удалось подписать challenge.',
  'login.challengeFailed': 'Не удалось связаться с сервером авторизации.',
  'login.verifyFailed': 'Проверка не выполнена.',
  'login.unauthorized': 'Сессия недействительна.',
  'login.noChallenge': 'Нет активного challenge, попробуйте снова.',
  'login.nonceMismatch': 'Несовпадение challenge, попробуйте снова.',
  'login.signatureInvalid': 'Подпись отклонена сервером.',
  'login.publicKeyRequired':
    'Сервер ожидал публичный ключ (регистрация).',
  'login.publicKeyConflict':
    'Публичный ключ не совпадает с записью на сервере.',
  'login.usernameTaken': 'Этот логин уже занят.',
  'login.invalidBody': 'Неверный запрос.',
  'login.handleLabel': 'Логин',
  'login.vaultPassphraseLabel': 'Парольная фраза vault',
  'login.handlePlaceholder': 'оператор',
  'login.authLoading': 'Проверка сессии...',
  'login.newDevice': 'Новое устройство',
  'login.existingVault': 'Существующий vault',

  'guide.step': 'Шаг',
  'guide.onboardingTitle': 'Онбординг',
  'guide.enter': 'Войти в Project 13',
  'guide.keyGeneration.title': 'Генерация ключей',
  'guide.keyGeneration.body':
    'При регистрации браузер создает две пары ключей: ECDSA (авторизация) и ECDH (E2E шифрование). Приватные ключи не покидают устройство.',
  'guide.vaultEncryption.title': 'Шифрование vault',
  'guide.vaultEncryption.body':
    'Приватные ключи упаковываются AES-256-GCM с ключом из парольной фразы (PBKDF2, 210k итераций). Зашифрованный vault хранится в localStorage.',
  'guide.zeroKnowledge.title': 'Zero knowledge',
  'guide.zeroKnowledge.body':
    'Сервер хранит только публичные ключи и зашифрованные сообщения. Он не может читать сообщения или расшифровывать медиа.',
  'guide.discoverability.title': 'Обнаруживаемость',
  'guide.discoverability.body':
    'По умолчанию аккаунт скрыт. Включите Discoverable в настройках, чтобы вас находили по имени.',
  'guide.backup.title': 'Резервная копия vault',
  'guide.backup.body':
    'Используйте Settings -> Export Vault, чтобы сохранить зашифрованную копию. На новом устройстве импортируйте ее для восстановления доступа.',

  'sidebar.channels': 'Каналы',
  'sidebar.openDirect': 'Личный чат',
  'sidebar.peerPlaceholder': 'UUID или имя пользователя',
  'sidebar.copyInviteSuccess': 'Ссылка-приглашение скопирована',
  'sidebar.userNotFound': 'Пользователь не найден или скрыт',
  'sidebar.cannotOpenSelf': 'Нельзя открыть личный чат с самим собой',
  'sidebar.createFailed': 'Не удалось создать чат',

  'settings.discoverable': 'Обнаруживаемость',
  'settings.discoverableHint': 'Виден в публичном поиске пользователей',
  'settings.vaultBackup': 'Резервная копия vault',
  'settings.languageHint': 'Выберите язык интерфейса',
  'settings.noLocalVault': 'Локальный vault не найден',
  'settings.invalidVaultFile': 'Некорректный файл vault',
  'settings.importFailed': 'Не удалось импортировать',
  'settings.toggleFailed': 'Не удалось обновить настройку',
  'settings.unknown': 'Неизвестная ошибка',
} as const

export default ru

