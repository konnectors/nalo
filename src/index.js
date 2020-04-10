process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://f1a087d566d2464eb02fd858bd00b30f@sentry.cozycloud.cc/135'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  cozyClient,
  updateOrCreate
} = require('cozy-konnector-libs')
const moment = require('moment')
const doctypes = require('cozy-doctypes')
const {
  Document,
  BankAccount,
  BankTransaction,
  BalanceHistory,
  BankingReconciliator
} = doctypes

Document.registerClient(cozyClient)

// Banking reconciliator used to save the accounts
const reconciliator = new BankingReconciliator({ BankAccount, BankTransaction })

// Requests options
const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true,
  // Use default user-agent
  userAgent: true
})

const baseApiUrl = 'https://nalo.fr/api/v1'

module.exports = new BaseKonnector(start)

// Main function
async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  const userToken = await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Retrieving details of bank accounts')
  const bankAccounts = await getBankAccounts(userToken)

  log('info', 'Saving accounts and balances')
  // Save accounts, without any operations as there are none for life insurance
  const { accounts: savedAccounts } = await reconciliator.save(bankAccounts, [])
  await saveBalances(savedAccounts)

  log('info', 'All done!')
}

// Authenticate to Nalo
function authenticate(username, password) {
  return request(`${baseApiUrl}/login`, {
    method: 'POST',
    form: {
      email: username,
      password: password,
      userToken: false
    }
  })
    .then($ => {
      if ($.detail.token) {
        return $.detail.token
      } else {
        log('error', 'Failed to retrieve user token')
        throw new Error(errors.LOGIN_FAILED)
      }
    })
    .catch($ => {
      log('error', $.error.detail)
      throw new Error(errors.LOGIN_FAILED)
    })
}

// Create Cozy bank accounts, see documentation on https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts
function getBankAccounts(userToken) {
  return request(`${baseApiUrl}/projects/mine/without-details`, {
    headers: {
      Authorization: 'Token ' + userToken
    }
  })
    .then($ => {
      if ($.detail) {
        let accounts = []
        for (let x of $.detail) {
          accounts.push({
            label: x.name,
            institutionLabel: 'Nalo',
            balance: parseFloat(x.current_value.toFixed(2)),
            type: 'LifeInsurance',
            number: x.id.toString(),
            vendorId: x.id.toString(),
            currency: 'EUR'
          })
        }
        return accounts
      } else {
        log('error', 'Failed to retrieve project details')
        throw new Error(errors.LOGIN_FAILED)
      }
    })
    .catch($ => {
      log('error', $.error)
      throw new Error(errors.VENDOR_DOWN)
    })
}

// Create Cozy balance histories, see documentation on https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankbalancehistories
async function saveBalances(accounts) {
  const now = moment()
  const balances = await Promise.all(
    accounts.map(async account => {
      const history = await BalanceHistory.getByYearAndAccount(
        now.year(),
        account._id
      )
      history.balances[now.format('YYYY-MM-DD')] = account.balance

      return history
    })
  )

  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}
