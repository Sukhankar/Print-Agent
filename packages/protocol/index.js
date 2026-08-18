/**
 * @print-agent/protocol
 * Protocol schemas, validation helpers, and TSPL sanitization rules.
 */

'use strict';

const { validateTspl, ALLOWED_TSPL_COMMANDS, FORBIDDEN_TSPL_COMMANDS } = require('./tsplSanitizer');
const { validateCreateJobSchema, validateRegisterPrinterSchema }        = require('./schemas');

module.exports = {
  validateTspl,
  ALLOWED_TSPL_COMMANDS,
  FORBIDDEN_TSPL_COMMANDS,
  validateCreateJobSchema,
  validateRegisterPrinterSchema,
};
