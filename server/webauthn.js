// Вход по Face ID (технология passkey, стандарт WebAuthn).
//
// Телефон хранит секретный ключ у себя и подтверждает вход лицом, а сервер
// проверяет подпись открытым ключом. Пароль или код при этом никуда
// не передаются — красть у сервера нечего.
//
// Реализовано без внешних библиотек: разбор CBOR и проверка подписи
// сделаны на стандартных средствах Node.js.

import { createHash, createPublicKey, verify as verifySignature, randomBytes } from 'node:crypto';

export const b64url = {
  encode: (buffer) => Buffer.from(buffer).toString('base64url'),
  decode: (value) => Buffer.from(String(value), 'base64url'),
};

// ------------------------------------------------------------------- CBOR

// Минимальный разбор CBOR: столько, сколько нужно для ответа устройства.
function readItem(buffer, offset) {
  const first = buffer[offset];
  const major = first >> 5;
  const minor = first & 0x1f;
  let value = minor;
  let cursor = offset + 1;

  if (minor === 24) { value = buffer.readUInt8(cursor); cursor += 1; }
  else if (minor === 25) { value = buffer.readUInt16BE(cursor); cursor += 2; }
  else if (minor === 26) { value = buffer.readUInt32BE(cursor); cursor += 4; }
  else if (minor === 27) { value = Number(buffer.readBigUInt64BE(cursor)); cursor += 8; }
  else if (minor > 27) throw new Error('Неподдерживаемая запись CBOR');

  switch (major) {
    case 0: return { value, offset: cursor };
    case 1: return { value: -1 - value, offset: cursor };
    case 2: return { value: buffer.subarray(cursor, cursor + value), offset: cursor + value };
    case 3: return { value: buffer.subarray(cursor, cursor + value).toString('utf8'), offset: cursor + value };
    case 4: {
      const items = [];
      let next = cursor;
      for (let i = 0; i < value; i += 1) {
        const item = readItem(buffer, next);
        items.push(item.value);
        next = item.offset;
      }
      return { value: items, offset: next };
    }
    case 5: {
      const map = new Map();
      let next = cursor;
      for (let i = 0; i < value; i += 1) {
        const key = readItem(buffer, next);
        const item = readItem(buffer, key.offset);
        map.set(key.value, item.value);
        next = item.offset;
      }
      return { value: map, offset: next };
    }
    case 7: {
      if (minor === 20) return { value: false, offset: cursor };
      if (minor === 21) return { value: true, offset: cursor };
      if (minor === 22) return { value: null, offset: cursor };
      return { value: undefined, offset: cursor };
    }
    default:
      throw new Error('Неподдерживаемый тип CBOR');
  }
}

export function decodeCBOR(buffer) {
  return readItem(Buffer.from(buffer), 0).value;
}

// --------------------------------------------------- данные аутентификатора

export function parseAuthData(authData) {
  const buffer = Buffer.from(authData);
  const rpIdHash = buffer.subarray(0, 32);
  const flags = buffer[32];
  const signCount = buffer.readUInt32BE(33);
  const result = {
    rpIdHash,
    flags,
    signCount,
    userPresent: Boolean(flags & 0x01),
    userVerified: Boolean(flags & 0x04),
    hasCredential: Boolean(flags & 0x40),
  };
  if (!result.hasCredential) return result;

  const credIdLength = buffer.readUInt16BE(53);
  result.credentialId = buffer.subarray(55, 55 + credIdLength);
  const publicKeyStart = 55 + credIdLength;
  result.coseKey = decodeCBOR(buffer.subarray(publicKeyStart));
  return result;
}

// Ключ устройства приходит в формате COSE — переводим его в JWK,
// с которым умеет работать Node.js.
export function coseToJwk(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2) {
    return {
      alg,
      jwk: {
        kty: 'EC',
        crv: 'P-256',
        x: b64url.encode(cose.get(-2)),
        y: b64url.encode(cose.get(-3)),
      },
    };
  }
  if (kty === 3) {
    return {
      alg,
      jwk: {
        kty: 'RSA',
        n: b64url.encode(cose.get(-1)),
        e: b64url.encode(cose.get(-2)),
      },
    };
  }
  throw new Error('Устройство прислало ключ неизвестного типа');
}

function publicKeyFrom(jwk) {
  return createPublicKey({ key: jwk, format: 'jwk' });
}

// ------------------------------------------------------------- проверки

export function sha256(data) {
  return createHash('sha256').update(data).digest();
}

export function createChallenge() {
  return b64url.encode(randomBytes(32));
}

function parseClientData(clientDataJSON) {
  return JSON.parse(b64url.decode(clientDataJSON).toString('utf8'));
}

function checkClientData(clientData, { type, challenge, origins }) {
  if (clientData.type !== type) throw new Error('Неожиданный тип запроса от устройства');
  if (clientData.challenge !== challenge) throw new Error('Устаревший запрос, попробуйте ещё раз');
  if (!origins.includes(clientData.origin)) throw new Error(`Вход с адреса ${clientData.origin} не разрешён`);
}

// Регистрация: устройство создало ключ, сохраняем его открытую часть.
export function verifyRegistration({ response, challenge, origins, rpId }) {
  const clientData = parseClientData(response.clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.create', challenge, origins });

  const attestation = decodeCBOR(b64url.decode(response.attestationObject));
  const authData = parseAuthData(attestation.get('authData'));

  if (!authData.hasCredential) throw new Error('Устройство не прислало ключ');
  if (!authData.userVerified) throw new Error('Вход не подтверждён Face ID или кодом устройства');
  if (!authData.rpIdHash.equals(sha256(rpId))) throw new Error('Ключ создан для другого адреса');

  const { jwk, alg } = coseToJwk(authData.coseKey);
  return {
    credentialId: b64url.encode(authData.credentialId),
    publicKey: jwk,
    alg,
    signCount: authData.signCount,
  };
}

// Вход: проверяем подпись открытым ключом, сохранённым при регистрации.
export function verifyAssertion({ response, challenge, origins, rpId, credential }) {
  const clientData = parseClientData(response.clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.get', challenge, origins });

  const authDataBuffer = b64url.decode(response.authenticatorData);
  const authData = parseAuthData(authDataBuffer);
  if (!authData.rpIdHash.equals(sha256(rpId))) throw new Error('Ключ создан для другого адреса');
  if (!authData.userPresent) throw new Error('Устройство не подтвердило присутствие владельца');
  if (!authData.userVerified) throw new Error('Вход не подтверждён Face ID или кодом устройства');

  const signed = Buffer.concat([authDataBuffer, sha256(b64url.decode(response.clientDataJSON))]);
  const signature = b64url.decode(response.signature);
  const key = publicKeyFrom(credential.publicKey);
  const ok = credential.publicKey.kty === 'EC'
    ? verifySignature('sha256', signed, { key, dsaEncoding: 'der' }, signature)
    : verifySignature('sha256', signed, key, signature);
  if (!ok) throw new Error('Подпись устройства не подошла');

  // Счётчик защищает от копирования ключа; у Apple он всегда 0 — это нормально.
  if (authData.signCount > 0 && credential.signCount > 0 && authData.signCount <= credential.signCount) {
    throw new Error('Повторное использование ключа');
  }
  return { signCount: authData.signCount };
}
