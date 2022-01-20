const router = require('express').Router()
let student = require('../models/student.model')

router.route('/').get((req,res)=>{
  student.find()
  .then(students=>res.json())
  .catch(err=>res.status(400).json("Error:"+err))
});

router.route("/add").get((req, res) => {
  const studentName= req.body.studentName;
  const fatherName=  req.body.fatherName;
  const dob=  Date.parse(req.body.dob);
  const email=  req.body.email;
  const address=  req.body.address;
  const gender=  req.body.gender;
  const course=  req.body.course;
  const mobileNumber=  Number.parse(req.body.mobileNumber);


 const newStudent = new student({studentName,fatherName,dob,email,address,gender,course,mobileNumber})

 newStudent.save()
 .then(()=> res.json("student Added!"))
 .catch(err=> res.status(400).json("Error:"+err))
});


module.exports=router;