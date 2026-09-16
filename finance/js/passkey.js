// Вход по Face ID на стороне приложения.
//
// Секретный ключ создаётся и хранится в самом телефоне (в Secure Enclave),
// приложению он недоступен. Мы только передаём серверу подпись, которую
// телефон делает после подтверждения лицом.

const toBase64Url = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value) => {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Не удалось связаться с сервером');
  return payload;
}

// Face ID доступен только по защищённому адресу — это требование браузера.
export function isSupported() {
  return Boolean(window.PublicKeyCredential) && window.isSecureContext;
}

export async function isPhoneReady() {
  if (!isSupported()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// Есть ли на сервере хоть один привязанный телефон.
export async function isAvailable() {
  if (!isSupported()) return false;
  try {
    const options = await api('/passkey/login/options');
    return Boolean(options.available);
  } catch {
    return false;
  }
}

export async function signIn() {
  const options = await api('/passkey/login/options');
  if (!options.available) {
    throw new Error('Телефон ещё не привязан. Войдите по коду и включите Face ID в настройках.');
  }
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(options.challenge),
      rpId: options.rpId,
      allowCredentials: (options.allowCredentials || []).map((item) => ({
        id: fromBase64Url(item.id),
        type: 'public-key',
      })),
      userVerification: 'required',
      timeout: 60000,
    },
  });
  if (!credential) throw new Error('Вход отменён');

  const payload = await api('/passkey/login/verify', {
    id: toBase64Url(credential.rawId),
    response: {
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      authenticatorData: toBase64Url(credential.response.authenticatorData),
      signature: toBase64Url(credential.response.signature),
    },
  });
  return payload.user;
}

export async function register(label) {
  const options = await api('/passkey/register/options');
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64Url(options.challenge),
      rp: options.rp,
      user: {
        id: fromBase64Url(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },   // ES256 — его используют iPhone и Mac
        { type: 'public-key', alg: -257 }, // RS256 — запасной вариант
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      excludeCredentials: (options.excludeCredentials || []).map((item) => ({
        id: fromBase64Url(item.id),
        type: 'public-key',
      })),
      attestation: 'none',
      timeout: 60000,
    },
  });
  if (!credential) throw new Error('Привязка отменена');

  return api('/passkey/register/verify', {
    id: toBase64Url(credential.rawId),
    label: label || 'Телефон',
    response: {
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      attestationObject: toBase64Url(credential.response.attestationObject),
    },
  });
}

export async function list() {
  const response = await fetch('/api/passkey', { credentials: 'same-origin' });
  if (!response.ok) return { secure: false, passkeys: [] };
  return response.json();
}

export async function remove(id) {
  return api('/passkey/delete', { id });
}
