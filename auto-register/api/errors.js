export class Failure extends Error {
  constructor(status, message, code=null, nextAction=null) { super(message); this.status = status; this.code=code; this.next_action=nextAction; }
}

export function errorDetails(error,status) {
  const telegram=error.errorMessage||'';
  const known={SESSION_PASSWORD_NEEDED:['TELEGRAM_PASSWORD_REQUIRED','provide_password'],AUTH_KEY_UNREGISTERED:['TELEGRAM_SESSION_EXPIRED','reauthenticate'],SESSION_REVOKED:['TELEGRAM_SESSION_EXPIRED','reauthenticate'],SESSION_EXPIRED:['TELEGRAM_SESSION_EXPIRED','reauthenticate'],PHONE_CODE_INVALID:['TELEGRAM_CODE_INVALID','provide_code'],PHONE_CODE_EXPIRED:['TELEGRAM_CODE_EXPIRED','resend_code']};
  const defaults={400:['INVALID_INPUT','correct_input'],401:['AUTHENTICATION_REQUIRED','login'],403:['ACCESS_DENIED','contact_administrator'],404:['NOT_FOUND','review'],409:['STATE_CONFLICT','review'],410:['CHALLENGE_EXPIRED','resend_code'],429:['RATE_LIMITED','wait'],503:['DEPENDENCY_UNAVAILABLE','retry_later']};
  const [code,action]=known[telegram]||defaults[status]||['OPERATION_FAILED','review'];
  return {code:error.code||code,next_action:error.next_action||action,retryable:status===429&&error.code!=='RESOURCE_QUOTA'||status===503};
}
