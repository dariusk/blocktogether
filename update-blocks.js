var twitterAPI = require('node-twitter-api'),
    fs = require('fs'),
    setup = require('./setup'),
    updateUsers = require('./update-users');

var twitter = setup.twitter,
    BtUser = setup.BtUser,
    TwitterUser = setup.TwitterUser,
    BlockBatch = setup.BlockBatch,
    Block = setup.Block;

/**
 * For each user with stored credentials, fetch all of their blocked user ids,
 * and start filling the users table with data about those ids.
 */
function forAllUsersUpdateBlocks() {
  BtUser
    .findAll({
      // Get the latest complete BlockBatch for the user and skip if < 1 day
      include: [{
        model: BlockBatch,
        where: { complete: true },
        required: false,
        limit: 1,
        order: 'updatedAt DESC',
      }]
    }).error(function(err) {
      console.log(err);
    }).success(function(users) {
      users.forEach(function(user) {
        var oneDayInMillis = 86400 * 1000;
        var batches = user.blockBatches;
        if (batches &&
            batches.length > 0 &&
            (new Date() - new Date(batches[0].createdAt)) < oneDayInMillis) {
          console.log('Skipping', user.uid, '- already up to date.');
        } else {
          updateBlocks(user);
        }
      });
    });
}

/**
 * For a given BtUser, fetch all current blocks and store in DB.
 *
 * @param{BtUser} user The user whose blocks we want to fetch.
 */
function updateBlocks(user) {
  BlockBatch.create({
    source_uid: user.uid
  }).error(function(err) {
    console.log(err);
  }).success(function(blockBatch) {
    fetchAndStoreBlocks(blockBatch, user.access_token, user.access_token_secret);
  });
}

function fetchAndStoreBlocks(blockBatch, accessToken, accessTokenSecret, cursor) {
  console.log('Fetching blocks for', blockBatch.source_uid);
  // A function that can simply be called again to run this once more with an
  // update cursor.
  var getMore = fetchAndStoreBlocks.bind(null,
    blockBatch, accessToken, accessTokenSecret);
  var currentCursor = cursor || -1;
  twitter.blocks("ids", {
      // Stringify ids is very important, or we'll get back numeric ids that
      // will get subtly mangled by JS.
      stringify_ids: true,
      cursor: currentCursor,
    },
    accessToken, accessTokenSecret,
    handleIds.bind(null, blockBatch, currentCursor, getMore));
}

function handleIds(blockBatch, currentCursor, getMore, err, results) {
  if (err) {
    if (err.statusCode === 429) {
      console.log('Rate limited. Trying again in 15 minutes.');
      setTimeout(function() {
        getMore(currentCursor);
      }, 15 * 60 * 1000);
    } else {
      console.log(err);
    }
    return;
  }

  // Update the current cursor stored with the blockBatch. Not currently used,
  // but may be useful to resume fetching blocks across restarts of this script.
  blockBatch.currentCursor = currentCursor;
  blockBatch.save();

  // First, add any new uids to the TwitterUser table if they aren't already
  // there (note ignoreDuplicates so we don't overwrite fleshed-out users).
  // Note: even though the field name is 'ids', these are actually stringified
  // ids because we specified that in the request.
  var usersToCreate = results.ids.map(function(id) {
    return {uid: id};
  });
  TwitterUser.bulkCreate(usersToCreate, { ignoreDuplicates: true });

  // Now we create block entries for all the blocked ids. Note: setting
  // BlockBatchId explicitly here doesn't show up in the documentation,
  // but it seems to work.
  var blocksToCreate = results.ids.map(function(id) {
    return {
      sink_uid: id,
      BlockBatchId: blockBatch.id
    };
  });
  Block
    .bulkCreate(blocksToCreate)
    .error(function(err) {
      console.log(err);
    }).success(function(blocks) {
      updateUsers.findAndUpdateUsers();
    });

  // Check whether we're done or next to grab the items at the next cursor.
  if (results.next_cursor_str === '0') {
    console.log('Finished fetching', results.ids.length, 'blocks for user',
      blockBatch.source_uid);
    blockBatch.complete = true;
    blockBatch.save().error(function(err) {
      console.log(err);
    });
  } else {
    console.log('Cursoring ', results.next_cursor_str);
    getMore(results.next_cursor_str);
  }
}

module.exports = {
  updateBlocks: updateBlocks
};

if (require.main === module) {
  forAllUsersUpdateBlocks();
  setInterval(forAllUsersUpdateBlocks, 60 * 1000);
}
