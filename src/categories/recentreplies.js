
'use strict';

var _ = require('lodash');

var db = require('../database');
var posts = require('../posts');
var topics = require('../topics');
var privileges = require('../privileges');
var batch = require('../batch');

module.exports = function (Categories) {
	Categories.getRecentReplies = async function (cid, uid, count) {
		if (!parseInt(count, 10)) {
			return [];
		}
		let pids = await db.getSortedSetRevRange('cid:' + cid + ':pids', 0, count - 1);
		pids = await privileges.posts.filter('topics:read', pids, uid);
		return await posts.getPostSummaryByPids(pids, uid, { stripTags: true });
	};

	Categories.updateRecentTid = async function (cid, tid) {
		const [count, numRecentReplies] = await Promise.all([
			db.sortedSetCard('cid:' + cid + ':recent_tids'),
			db.getObjectField('category:' + cid, 'numRecentReplies'),
		]);

		if (count < numRecentReplies) {
			return await db.sortedSetAdd('cid:' + cid + ':recent_tids', Date.now(), tid);
		}
		const data = await db.getSortedSetRangeWithScores('cid:' + cid + ':recent_tids', 0, count - numRecentReplies);
		if (data.length) {
			await db.sortedSetsRemoveRangeByScore(['cid:' + cid + ':recent_tids'], '-inf', data[data.length - 1].score);
		}
		await db.sortedSetAdd('cid:' + cid + ':recent_tids', Date.now(), tid);
	};

	Categories.updateRecentTidForCid = async function (cid) {
		const pids = await db.getSortedSetRevRange('cid:' + cid + ':pids', 0, 0);
		if (!pids.length) {
			return;
		}
		const tid = await posts.getPostField(pids[0], 'tid');
		if (!tid) {
			return;
		}
		await Categories.updateRecentTid(cid, tid);
	};

	Categories.getRecentTopicReplies = async function (categoryData, uid) {
		if (!Array.isArray(categoryData) || !categoryData.length) {
			return;
		}
		const categoriesToLoad = categoryData.filter(category => category && category.numRecentReplies && parseInt(category.numRecentReplies, 10) > 0);
		const keys = categoriesToLoad.map(category => 'cid:' + category.cid + ':recent_tids');
		const results = await db.getSortedSetsMembers(keys);
		let tids = _.uniq(_.flatten(results).filter(Boolean));

		tids = await privileges.topics.filterTids('topics:read', tids, uid);
		const topics = await getTopics(tids, uid);
		assignTopicsToCategories(categoryData, topics);

		bubbleUpChildrenPosts(categoryData);
	};

	async function getTopics(tids, uid) {
		const topicData = await topics.getTopicsFields(tids, ['tid', 'mainPid', 'slug', 'title', 'teaserPid', 'cid', 'postcount']);
		topicData.forEach(function (topic) {
			if (topic) {
				topic.teaserPid = topic.teaserPid || topic.mainPid;
			}
		});
		var cids = _.uniq(topicData.map(topic => topic && topic.cid).filter(cid => parseInt(cid, 10)));
		const [categoryData, teasers] = await Promise.all([
			Categories.getCategoriesFields(cids, ['cid', 'parentCid']),
			topics.getTeasers(topicData, uid),
		]);
		var parentCids = {};
		categoryData.forEach(function (category) {
			parentCids[category.cid] = category.parentCid;
		});
		teasers.forEach(function (teaser, index) {
			if (teaser) {
				teaser.cid = topicData[index].cid;
				teaser.parentCid = parseInt(parentCids[teaser.cid], 10) || 0;
				teaser.tid = undefined;
				teaser.uid = undefined;
				teaser.topic = {
					slug: topicData[index].slug,
					title: topicData[index].title,
				};
			}
		});
		return teasers.filter(Boolean);
	}

	function assignTopicsToCategories(categories, topics) {
		categories.forEach(function (category) {
			if (category) {
				category.posts = topics.filter(topic => topic.cid && (topic.cid === category.cid || topic.parentCid === category.cid))
					.sort((a, b) => b.pid - a.pid)
					.slice(0, parseInt(category.numRecentReplies, 10));
			}
		});
	}

	function bubbleUpChildrenPosts(categoryData) {
		categoryData.forEach(function (category) {
			if (category) {
				if (category.posts.length) {
					return;
				}
				var posts = [];
				getPostsRecursive(category, posts);

				posts.sort((a, b) => b.pid - a.pid);
				if (posts.length) {
					category.posts = [posts[0]];
				}
			}
		});
	}

	function getPostsRecursive(category, posts) {
		if (Array.isArray(category.posts)) {
			category.posts.forEach(function (p) {
				posts.push(p);
			});
		}

		category.children.forEach(function (child) {
			getPostsRecursive(child, posts);
		});
	}
	// terrible name, should be topics.moveTopicPosts
	Categories.moveRecentReplies = async function (tid, oldCid, cid) {
		await updatePostCount(tid, oldCid, cid);
		const pids = await topics.getPids(tid);

		await batch.processArray(pids, async function (pids) {
			const postData = await posts.getPostsFields(pids, ['pid', 'uid', 'timestamp', 'upvotes', 'downvotes']);
			const timestamps = postData.map(p => p && p.timestamp);
			const bulkRemove = [];
			const bulkAdd = [];
			postData.forEach((post) => {
				bulkRemove.push(['cid:' + oldCid + ':uid:' + post.uid + ':pids', post.pid]);
				bulkRemove.push(['cid:' + oldCid + ':uid:' + post.uid + ':pids:votes', post.pid]);
				bulkAdd.push(['cid:' + cid + ':uid:' + post.uid + ':pids', post.timestamp, post.pid]);
				if (post.votes > 0) {
					bulkAdd.push(['cid:' + cid + ':uid:' + post.uid + ':pids:votes', post.votes, post.pid]);
				}
			});

			await Promise.all([
				db.sortedSetRemove('cid:' + oldCid + ':pids', pids),
				db.sortedSetAdd('cid:' + cid + ':pids', timestamps, pids),
				db.sortedSetRemoveBulk(bulkRemove),
				db.sortedSetAddBulk(bulkAdd),
			]);
		}, { batch: 500 });
	};

	async function updatePostCount(tid, oldCid, newCid) {
		const postCount = await topics.getTopicField(tid, 'postcount');
		if (!postCount) {
			return;
		}

		await Promise.all([
			db.incrObjectFieldBy('category:' + oldCid, 'post_count', -postCount),
			db.incrObjectFieldBy('category:' + newCid, 'post_count', postCount),
		]);
	}
};
