const bcrypt = require('bcrypt');

const password = 'cashierpass123'; // Cashier's password
bcrypt.hash(password, 10).then(hash => {
    console.log(hash);
});