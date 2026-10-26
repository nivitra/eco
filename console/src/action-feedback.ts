/** Enqueuing work is not evidence that publication, delivery or verification finished. */
export function actionSuccess(name: string): string {
  switch (name) {
    case 'Submit ownership claim':
      return 'Claim submitted — ownership review pending';
    case 'Submit demo claim':
      return 'Demo claim submitted — ownership not verified';
    case 'Publish website':
      return 'Publication queued — delivery checks pending';
    case 'Queue domain migration':
      return 'Domain migration queued — verification pending';
    case 'Check public access':
      return 'Public access check queued';
    default:
      return name + ' completed';
  }
}
